from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from datetime import date, timedelta, datetime
from typing import Optional, List
import holidays

import database as db
from mailer import send_email_notification

db.Base.metadata.create_all(bind=db.engine)

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

# --- CALCUL DES JOURS OUVRÉS (HORS WEEK-ENDS ET JOURS FÉRIÉS FRANÇAIS) ---
def is_working_day(d: date, fr_holidays) -> bool:
    # 0 = Lundi ... 4 = Vendredi ET ne doit pas être dans le dictionnaire des jours fériés
    return d.weekday() < 5 and d not in fr_holidays

def calculate_working_days_details(start: date, end: date, start_half: str, end_half: str):
    if end < start:
        return {"days_count": 0.0, "holidays": []}

    # Charge les jours fériés français pour la ou les années concernées
    years = list(range(start.year, end.year + 1))
    fr_holidays = holidays.France(years=years, language="fr")

    total_days = 0.0
    holidays_in_period = []

    current = start
    while current <= end:
        if current.weekday() < 5:  # Du Lundi au Vendredi
            if current in fr_holidays:
                holidays_in_period.append({
                    "date": current.isoformat(),
                    "name": fr_holidays.get(current)
                })
            else:
                total_days += 1.0
        current += timedelta(days=1)

    # Ajustement des demi-journées (uniquement si le jour de début/fin est un vrai jour travaillé)
    if start == end:
        if is_working_day(start, fr_holidays):
            if start_half == "afternoon" and end_half == "morning":
                total_days = 0.0
            elif start_half == "afternoon" or end_half == "morning":
                total_days = 0.5
    else:
        if is_working_day(start, fr_holidays) and start_half == "afternoon":
            total_days -= 0.5
        if is_working_day(end, fr_holidays) and end_half == "morning":
            total_days -= 0.5

    return {
        "days_count": max(total_days, 0.0),
        "holidays": holidays_in_period
    }

# --- SCHÉMAS PYDANTIC ---
class LoginRequest(BaseModel):
    email: EmailStr

class UserCreate(BaseModel):
    full_name: str
    email: EmailStr
    role: str = "employee"

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

class UserOut(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
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
    end_half_day: str = "afternoon"
):
    return calculate_working_days_details(start_date, end_date, start_half_day, end_half_day)

# --- ROUTES AUTH & UTILISATEURS ---
@app.post("/api/login", response_model=UserOut)
def login(req: LoginRequest, session: Session = Depends(get_db)):
    user = session.query(db.User).filter(db.User.email == req.email.lower().strip()).first()
    if not user:
        raise HTTPException(status_code=404, detail="Aucun compte SAT trouvé avec cet email.")
    return user

@app.get("/api/users", response_model=List[UserOut])
def get_users(session: Session = Depends(get_db)):
    return session.query(db.User).order_by(db.User.full_name.asc()).all()

@app.post("/api/users", response_model=UserOut)
def create_user(req: UserCreate, session: Session = Depends(get_db)):
    clean_email = req.email.lower().strip()
    existing = session.query(db.User).filter(db.User.email == clean_email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Cet email existe déjà chez SAT.")
    
    new_user = db.User(
        full_name=req.full_name.strip(),
        email=clean_email,
        role=req.role
    )
    session.add(new_user)
    session.commit()
    session.refresh(new_user)
    return new_user

@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, session: Session = Depends(get_db)):
    user = session.query(db.User).filter(db.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable.")
    if user.role == "admin":
        raise HTTPException(status_code=400, detail="Impossible de supprimer un compte administrateur.")
    
    session.query(db.LeaveRequest).filter(db.LeaveRequest.user_id == user_id).delete()
    session.delete(user)
    session.commit()
    return {"ok": True}

# --- ROUTES CONGÉS ---
@app.post("/api/leaves", response_model=LeaveOut)
def create_leave(req: LeaveCreate, session: Session = Depends(get_db)):
    user = session.query(db.User).filter(db.User.id == req.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable.")

    details = calculate_working_days_details(req.start_date, req.end_date, req.start_half_day, req.end_half_day)
    days = details["days_count"]
    if days <= 0:
        raise HTTPException(
            status_code=400,
            detail="La période sélectionnée ne contient aucun jour ouvré (uniquement week-end ou jour férié)."
        )

    new_leave = db.LeaveRequest(
        user_id=req.user_id,
        start_date=req.start_date,
        start_half_day=req.start_half_day,
        end_date=req.end_date,
        end_half_day=req.end_half_day,
        days_count=days,
        leave_type=req.leave_type,
        employee_comment=req.employee_comment
    )
    session.add(new_leave)
    session.commit()
    session.refresh(new_leave)

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
            <li><strong>Durée décomptée :</strong> {days} jour(s) ouvré(s)</li>
            {holidays_txt}
            <li><strong>Motif :</strong> {req.employee_comment or 'Non précisé'}</li>
        </ul>
        <p>Rendez-vous sur votre portail RH SAT pour valider ou refuser cette demande.</p>
    </div>
    """
    send_email_notification("rh@sat.fr", f"[SAT Congés] Nouvelle demande - {user.full_name}", html)
    return new_leave

@app.get("/api/leaves", response_model=List[LeaveOut])
def get_leaves(user_id: Optional[int] = None, session: Session = Depends(get_db)):
    query = session.query(db.LeaveRequest)
    if user_id:
        query = query.filter(db.LeaveRequest.user_id == user_id)
    return query.order_by(db.LeaveRequest.created_at.desc()).all()

@app.patch("/api/leaves/{leave_id}/status", response_model=LeaveOut)
def update_leave_status(leave_id: int, req: LeaveStatusUpdate, session: Session = Depends(get_db)):
    leave = session.query(db.LeaveRequest).filter(db.LeaveRequest.id == leave_id).first()
    if not leave:
        raise HTTPException(status_code=404, detail="Demande introuvable.")
    
    if req.status not in ["approved", "rejected"]:
        raise HTTPException(status_code=400, detail="Statut invalide.")

    leave.status = req.status
    leave.admin_comment = req.admin_comment
    session.commit()
    session.refresh(leave)

    decision_fr = "VALIDÉE ✅" if req.status == "approved" else "REFUSÉE ❌"
    color = "#059669" if req.status == "approved" else "#e11d48"
    html = f"""
    <div style="font-family: sans-serif; color: #1e293b;">
        <h2 style="color: {color};">Votre demande de congés a été {decision_fr}</h2>
        <p>Bonjour <strong>{leave.employee.full_name}</strong>,</p>
        <p>Votre demande de <strong>{leave.leave_type}</strong> du {leave.start_date} au {leave.end_date} ({leave.days_count} jour(s)) a été traitée par le service RH.</p>
        <p><strong>Commentaire RH :</strong> {req.admin_comment or 'Aucun commentaire'}</p>
    </div>
    """
    send_email_notification(leave.employee.email, f"[SAT Congés] Demande {decision_fr}", html)
    return leave