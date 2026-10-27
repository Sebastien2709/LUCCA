from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr, Field
from datetime import date, timedelta, datetime
from typing import Optional, List
import holidays

import database as db
from mailer import send_email_notification

db.Base.metadata.create_all(bind=db.engine)
db.ensure_columns()

app = FastAPI(title="SAT - Gestion des Congés API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    session = db.SessionLocal()
    try:
        yield session
    finally:
        session.close()

# --- CALCUL DES JOURS (CP = jours OUVRABLES lundi->samedi, autres = jours OUVRÉS lundi->vendredi) ---
# Règle des jours ouvrables : un congé qui se termine un vendredi (journée complète) inclut le samedi suivant
# (un vendredi seul compte donc 2 jours). Mais pas plus de 5 samedis décomptés par exercice.
COMPTER_SAMEDI_APRES_VENDREDI = True

def calculate_working_days_details(start: date, end: date, start_half: str, end_half: str,
                                   leave_type: str = "Congés Payés (CP)", saturdays_left: Optional[int] = None):
    if end < start:
        return {"days_count": 0.0, "holidays": [], "saturdays_count": 0}

    ouvrable = leave_type in db.CP_TYPES
    max_wd = 5 if ouvrable else 4   # 4 = vendredi, 5 = samedi
    if saturdays_left is None:
        saturdays_left = db.MAX_SAMEDIS_PAR_EXERCICE

    effective_end = end
    if ouvrable and COMPTER_SAMEDI_APRES_VENDREDI and end.weekday() == 4 and end_half == "afternoon":
        effective_end = end + timedelta(days=1)

    years = list(range(start.year, effective_end.year + 1))
    fr_holidays = holidays.France(years=years, language="fr")

    weights = {}              # jour décompté -> poids (1 = journée entière)
    holidays_in_period = []
    saturdays = 0

    current = start
    while current <= effective_end:
        wd = current.weekday()
        if wd <= max_wd:
            if current in fr_holidays:
                holidays_in_period.append({
                    "date": current.isoformat(),
                    "name": fr_holidays.get(current)
                })
            elif wd == 5 and saturdays >= saturdays_left:
                pass  # plafond de samedis atteint : ce samedi n'est pas décompté
            else:
                weights[current] = 1.0
                if wd == 5:
                    saturdays += 1
        current += timedelta(days=1)

    # Demi-journées (uniquement si le jour de début/fin est réellement décompté)
    if start in weights and start_half == "afternoon":
        weights[start] -= 0.5
    if end in weights and end_half == "morning":
        weights[end] -= 0.5

    return {
        "days_count": max(sum(weights.values()), 0.0),
        "holidays": holidays_in_period,
        "saturdays_count": saturdays
    }

# --- SCHÉMAS PYDANTIC ---
class LoginRequest(BaseModel):
    email: EmailStr

class UserCreate(BaseModel):
    full_name: str
    email: EmailStr
    role: str = "employee"
    droits_cp: float = 30.0

class ManagerUpdate(BaseModel):
    manager_id: Optional[int] = None   # None = pas de manager, la RH valide

class RightsUpdate(BaseModel):
    droits_cp: Optional[float] = Field(default=None, ge=0, le=100)
    droits_fractionnement: Optional[float] = Field(default=None, ge=0, le=100)
    droits_rtt: Optional[float] = Field(default=None, ge=0, le=100)

class LeaveCreate(BaseModel):
    user_id: int
    start_date: date
    start_half_day: str = "morning"
    end_date: date
    end_half_day: str = "afternoon"
    leave_type: str
    employee_comment: Optional[str] = None

class LeaveStatusUpdate(BaseModel):
    status: str  # "approved" ou "rejected"
    admin_comment: Optional[str] = None
    decided_by_id: int   # qui décide : la RH ou le manager de l'employé

class UserOut(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
    droits_cp: float
    droits_fractionnement: float
    droits_rtt: float
    manager_id: Optional[int] = None
    manager_name: Optional[str] = None
    is_manager: bool = False
    samedis_utilises: int
    solde_cp: float    # calculé : droits - jours validés ou en attente (exercice en cours)
    solde_rtt: float
    class Config:
        from_attributes = True

class LeaveOut(BaseModel):
    id: int
    user_id: int
    start_date: date
    start_half_day: str
    end_date: date
    end_half_day: str
    days_count: float
    leave_type: str
    status: str
    employee_comment: Optional[str]
    admin_comment: Optional[str]
    created_at: datetime
    manager_id: Optional[int] = None
    manager_name: Optional[str] = None
    decided_by_name: Optional[str] = None
    rh_seen: Optional[bool] = False
    employee: UserOut
    class Config:
        from_attributes = True

# --- INITIALISATION COMPTES DE DÉMO ---
@app.on_event("startup")
def seed_initial_users():
    session = db.SessionLocal()
    if session.query(db.User).count() == 0:
        users = [
            db.User(email="rh@sat.fr", full_name="Responsable RH & Compta", role="admin"),
            db.User(email="jean.dupont@sat.fr", full_name="Jean Dupont", role="employee"),
            db.User(email="marie.curie@sat.fr", full_name="Marie Curie", role="employee"),
        ]
        session.add_all(users)
        session.commit()
        # Démo : Jean Dupont est le manager de Marie Curie
        jean = session.query(db.User).filter(db.User.email == "jean.dupont@sat.fr").first()
        marie = session.query(db.User).filter(db.User.email == "marie.curie@sat.fr").first()
        marie.manager_id = jean.id
        session.commit()
    session.close()

# --- ROUTES JOURS FÉRIÉS & APERÇU ---
@app.get("/api/holidays")
def get_french_holidays(year: int = Query(default=datetime.now().year)):
    fr_holidays = holidays.France(years=[year - 1, year, year + 1], language="fr")
    return {d.isoformat(): name for d, name in fr_holidays.items()}

@app.get("/api/leaves/preview")
def preview_leave_days(
    start_date: date,
    end_date: date,
    start_half_day: str = "morning",
    end_half_day: str = "afternoon",
    leave_type: str = "Congés Payés (CP)",
    user_id: Optional[int] = None,
    session: Session = Depends(get_db)
):
    saturdays_left = None
    if user_id and leave_type in db.CP_TYPES:
        u = session.query(db.User).filter(db.User.id == user_id).first()
        if u:
            saturdays_left = u.samedis_restants(start_date)
    return calculate_working_days_details(start_date, end_date, start_half_day, end_half_day, leave_type, saturdays_left)

# --- ROUTES AUTH & UTILISATEURS ---
@app.post("/api/login", response_model=UserOut)
def login(req: LoginRequest, session: Session = Depends(get_db)):
    user = session.query(db.User).filter(db.User.email == req.email.lower().strip()).first()
    if not user:
        raise HTTPException(status_code=404, detail="Aucun compte SAT trouvé avec cet email.")
    return user

@app.get("/api/users", response_model=List[UserOut])
def get_users(manager_id: Optional[int] = None, session: Session = Depends(get_db)):
    query = session.query(db.User)
    if manager_id:
        query = query.filter(db.User.manager_id == manager_id)
    return query.order_by(db.User.full_name.asc()).all()

@app.post("/api/users", response_model=UserOut)
def create_user(req: UserCreate, session: Session = Depends(get_db)):
    clean_email = req.email.lower().strip()
    existing = session.query(db.User).filter(db.User.email == clean_email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Cet email existe déjà chez SAT.")
    
    new_user = db.User(
        full_name=req.full_name.strip(),
        email=clean_email,
        role=req.role,
        droits_cp=req.droits_cp
    )
    session.add(new_user)
    session.commit()
    session.refresh(new_user)
    return new_user

@app.patch("/api/users/{user_id}/manager", response_model=UserOut)
def update_manager(user_id: int, req: ManagerUpdate, session: Session = Depends(get_db)):
    user = session.query(db.User).filter(db.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable.")
    manager = None
    if req.manager_id is not None:
        manager = session.query(db.User).filter(db.User.id == req.manager_id).first()
        if not manager:
            raise HTTPException(status_code=404, detail="Manager introuvable.")
        if manager.id == user.id:
            raise HTTPException(status_code=400, detail="Un collaborateur ne peut pas être son propre manager.")
        if manager.manager_id == user.id:
            raise HTTPException(status_code=400, detail="Ce manager est déjà un collaborateur de cette personne.")
    user.manager_id = manager.id if manager else None
    # Les demandes encore en attente suivent le nouveau circuit de validation
    for l in user.leaves:
        if l.status == "pending":
            l.manager_id = manager.id if manager else None
            l.manager_name = manager.full_name if manager else None
            l.rh_seen = manager is None
    session.commit()
    session.refresh(user)
    return user

@app.patch("/api/users/{user_id}/rights", response_model=UserOut)
def update_rights(user_id: int, req: RightsUpdate, session: Session = Depends(get_db)):
    user = session.query(db.User).filter(db.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable.")
    if req.droits_cp is not None:
        user.droits_cp = req.droits_cp
    if req.droits_fractionnement is not None:
        user.droits_fractionnement = req.droits_fractionnement
    if req.droits_rtt is not None:
        user.droits_rtt = req.droits_rtt
    session.commit()
    session.refresh(user)
    return user

@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, session: Session = Depends(get_db)):
    user = session.query(db.User).filter(db.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable.")
    if user.role == "admin":
        raise HTTPException(status_code=400, detail="Impossible de supprimer un compte administrateur.")
    
    # Son équipe n'a plus de manager ; ses demandes en cours repassent à la RH
    session.query(db.User).filter(db.User.manager_id == user_id).update({db.User.manager_id: None})
    session.query(db.LeaveRequest).filter(
        db.LeaveRequest.manager_id == user_id, db.LeaveRequest.status == "pending"
    ).update({db.LeaveRequest.manager_id: None, db.LeaveRequest.manager_name: None, db.LeaveRequest.rh_seen: True})
    session.query(db.LeaveRequest).filter(db.LeaveRequest.user_id == user_id).delete()
    session.delete(user)
    session.commit()
    return {"ok": True}

# --- ROUTES CONGÉS ---
@app.post("/api/leaves", response_model=LeaveOut)
def create_leave(req: LeaveCreate, session: Session = Depends(get_db)):
    # 1. Récupérer l'utilisateur qui fait la demande
    user = session.query(db.User).filter(db.User.id == req.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable.")

    # 2. Calculer le nombre de jours ouvrés réels de la demande
    saturdays_left = user.samedis_restants(req.start_date) if req.leave_type in db.CP_TYPES else None
    details = calculate_working_days_details(
        req.start_date, req.end_date, req.start_half_day, req.end_half_day, req.leave_type, saturdays_left
    )
    days = details["days_count"]
    
    if days <= 0:
        raise HTTPException(
            status_code=400,
            detail="La période sélectionnée ne contient aucun jour ouvré (uniquement week-end ou jour férié)."
        )

    # 3. Vérifier le solde de l'exercice (droits - jours validés ou en attente)
    solde = user.solde_for(req.leave_type, req.start_date)
    if solde is not None and days > solde:
        raise HTTPException(
            status_code=400,
            detail=f"Le nombre de jours posés sur ce compte ({days}) est supérieur au nombre de jours maximum disponible ({solde})."
        )

    # 4. Pas de déduction à stocker : le solde est recalculé à chaque lecture.
    #    Une demande refusée libère donc automatiquement ses jours.

    # 5. Créer la demande de congé
    new_leave = db.LeaveRequest(
        user_id=req.user_id,
        start_date=req.start_date,
        start_half_day=req.start_half_day,
        end_date=req.end_date,
        end_half_day=req.end_half_day,
        days_count=days,
        saturdays_count=details["saturdays_count"],
        manager_id=user.manager.id if user.manager else None,
        manager_name=user.manager.full_name if user.manager else None,
        rh_seen=user.manager is None,
        leave_type=req.leave_type,
        employee_comment=req.employee_comment
    )
    session.add(new_leave)
    session.commit()
    session.refresh(new_leave)

    # 6. Envoi de l'email (inchangé)
    holidays_txt = ""
    if details["holidays"]:
        names = ", ".join([f"{h['name']} ({h['date']})" for h in details["holidays"]])
        holidays_txt = f"<li><strong>Jours fériés non décomptés :</strong> {names}</li>"

    html = f"""
    <div style="font-family: sans-serif; color: #1e293b;">
        <h2 style="color: #4f46e5;">Nouvelle demande de congés SAT</h2>
        <p><strong>{user.full_name}</strong> a soumis une demande d'absence :</p>
        <ul>
            <li><strong>Type :</strong> {req.leave_type}</li>
            <li><strong>Période :</strong> Du {req.start_date} au {req.end_date}</li>
            <li><strong>Durée décomptée :</strong> {days} jour(s)</li>
            {holidays_txt}
            <li><strong>Motif :</strong> {req.employee_comment or 'Non précisé'}</li>
        </ul>
        <p><<CLOSING>></p>
    </div>
    """
    if user.manager:
        # Le manager valide ; la RH est simplement informée
        send_email_notification(
            user.manager.email, f"[SAT Congés] Demande à valider - {user.full_name}",
            html.replace("<<CLOSING>>", "Rendez-vous sur le portail SAT (onglet Équipe) pour valider ou refuser cette demande."))
        send_email_notification(
            "rh@sat.fr", f"[SAT Congés] Info : demande de {user.full_name} transmise à son manager",
            html.replace("<<CLOSING>>", f"Cette demande est validée par son manager, {user.manager.full_name}. Vous êtes simplement informé(e)."))
    else:
        send_email_notification(
            "rh@sat.fr", f"[SAT Congés] Nouvelle demande - {user.full_name}",
            html.replace("<<CLOSING>>", "Rendez-vous sur votre portail RH SAT pour valider ou refuser cette demande."))
    
    return new_leave

@app.get("/api/leaves", response_model=List[LeaveOut])
def get_leaves(user_id: Optional[int] = None, manager_id: Optional[int] = None, session: Session = Depends(get_db)):
    query = session.query(db.LeaveRequest)
    if user_id:
        query = query.filter(db.LeaveRequest.user_id == user_id)
    if manager_id:
        query = query.filter(db.LeaveRequest.manager_id == manager_id)
    return query.order_by(db.LeaveRequest.created_at.desc()).all()

@app.patch("/api/leaves/{leave_id}/seen", response_model=LeaveOut)
def mark_leave_seen(leave_id: int, session: Session = Depends(get_db)):
    leave = session.query(db.LeaveRequest).filter(db.LeaveRequest.id == leave_id).first()
    if not leave:
        raise HTTPException(status_code=404, detail="Demande introuvable.")
    leave.rh_seen = True
    session.commit()
    session.refresh(leave)
    return leave

@app.patch("/api/leaves/{leave_id}/status", response_model=LeaveOut)
def update_leave_status(leave_id: int, req: LeaveStatusUpdate, session: Session = Depends(get_db)):
    leave = session.query(db.LeaveRequest).filter(db.LeaveRequest.id == leave_id).first()
    if not leave:
        raise HTTPException(status_code=404, detail="Demande introuvable.")
    
    if req.status not in ["approved", "rejected"]:
        raise HTTPException(status_code=400, detail="Statut invalide.")

    # Qui a le droit de décider : la RH, ou le manager de l'employé pour cette demande
    actor = session.query(db.User).filter(db.User.id == req.decided_by_id).first()
    if not actor:
        raise HTTPException(status_code=400, detail="Décideur introuvable.")
    by_rh = actor.role == "admin"
    if not by_rh and not (leave.manager_id is not None and actor.id == leave.manager_id):
        raise HTTPException(status_code=403, detail="Vous n'êtes pas autorisé(e) à décider de cette demande.")
    if leave.status != "pending":
        raise HTTPException(status_code=400, detail="Cette demande a déjà été traitée.")

    leave.status = req.status
    leave.admin_comment = req.admin_comment
    leave.decided_by_id = actor.id
    leave.decided_by_name = actor.full_name
    # Décision d'un manager -> notification pour la RH (non lue) ; décision de la RH -> rien à notifier
    leave.rh_seen = True if (by_rh or leave.manager_id is None) else False
    session.commit()
    session.refresh(leave)

    decision_fr = "VALIDÉE ✅" if req.status == "approved" else "REFUSÉE ❌"
    color = "#059669" if req.status == "approved" else "#e11d48"
    html = f"""
    <div style="font-family: sans-serif; color: #1e293b;">
        <h2 style="color: {color};">Votre demande de congés a été {decision_fr}</h2>
        <p>Bonjour <strong>{leave.employee.full_name}</strong>,</p>
        <p>Votre demande de <strong>{leave.leave_type}</strong> du {leave.start_date} au {leave.end_date} ({leave.days_count} jour(s)) a été traitée par {actor.full_name}.</p>
        <p><strong>Commentaire :</strong> {req.admin_comment or 'Aucun commentaire'}</p>
    </div>
    """
    send_email_notification(leave.employee.email, f"[SAT Congés] Demande {decision_fr}", html)
    if not by_rh:
        send_email_notification(
            "rh@sat.fr", f"[SAT Congés] Info : {actor.full_name} a traité la demande de {leave.employee.full_name}",
            f"<p>{actor.full_name} a {decision_fr} la demande de {leave.leave_type} de <strong>{leave.employee.full_name}</strong> "
            f"du {leave.start_date} au {leave.end_date} ({leave.days_count} jour(s)).</p>")
    return leave

import os
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)