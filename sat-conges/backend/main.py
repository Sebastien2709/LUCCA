import os, html as _html
from contextlib import asynccontextmanager
from datetime import date, timedelta, datetime
from typing import Optional, List, Literal

import holidays
from fastapi import FastAPI, Depends, HTTPException, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Response, UploadFile, File
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr, Field, ConfigDict
from sqlalchemy import exists
from sqlalchemy.orm import Session

import database as db
from database import ROLE_EMPLOYEE, ROLE_MANAGER, ROLE_CONFIRMER, ROLE_ADMIN, ALL_ROLES
import security
import export_planning
from mailer import send_email_notification

APP_URL = os.environ.get("APP_URL", "")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.Base.metadata.create_all(bind=db.engine)
    yield


app = FastAPI(title="SAT - Gestion des Congés API", lifespan=lifespan)

# Le jeton passe dans l'en-tête Authorization (pas de cookie) -> CORS ouvert sans risque de CSRF,
# mais on restreint quand même au site SAT dès que ALLOWED_ORIGINS est défini.
_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"], expose_headers=["Content-Disposition"])


def get_db():
    session = db.SessionLocal()
    try:
        yield session
    finally:
        session.close()


# ==============================================================================
# AUTHENTIFICATION / AUTORISATIONS
# ==============================================================================
bearer = HTTPBearer(auto_error=False)


def current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
                 session: Session = Depends(get_db)) -> db.User:
    if not creds:
        raise HTTPException(401, "Connexion requise.")
    try:
        uid = security.decode_token(creds.credentials)
    except Exception:
        raise HTTPException(401, "Session expirée, reconnecte-toi.")
    user = session.get(db.User, uid)
    if not user or not user.is_active:
        raise HTTPException(401, "Compte introuvable ou désactivé.")
    return user


def require_admin(user: db.User = Depends(current_user)) -> db.User:
    if user.role != ROLE_ADMIN:
        raise HTTPException(403, "Réservé à la RH.")
    return user


# ==============================================================================
# CALCUL DES JOURS (inchangé : CP = jours ouvrables lundi->samedi, autres = ouvrés)
# ==============================================================================
COMPTER_SAMEDI_APRES_VENDREDI = True


def calculate_working_days_details(start: date, end: date, start_half: str, end_half: str,
                                   leave_type: str = "Congés Payés (CP)", saturdays_left: Optional[int] = None):
    if end < start:
        return {"days_count": 0.0, "holidays": [], "saturdays_count": 0}

    ouvrable = leave_type in db.CP_TYPES
    max_wd = 5 if ouvrable else 4
    if saturdays_left is None:
        saturdays_left = db.MAX_SAMEDIS_PAR_EXERCICE

    effective_end = end
    if ouvrable and COMPTER_SAMEDI_APRES_VENDREDI and end.weekday() == 4 and end_half == "afternoon":
        effective_end = end + timedelta(days=1)

    fr_holidays = holidays.France(years=list(range(start.year, effective_end.year + 1)), language="fr")
    weights, holidays_in_period, saturdays = {}, [], 0

    current = start
    while current <= effective_end:
        wd = current.weekday()
        if wd <= max_wd:
            if current in fr_holidays:
                holidays_in_period.append({"date": current.isoformat(), "name": fr_holidays.get(current)})
            elif wd == 5 and saturdays >= saturdays_left:
                pass
            else:
                weights[current] = 1.0
                if wd == 5:
                    saturdays += 1
        current += timedelta(days=1)

    if start in weights and start_half == "afternoon":
        weights[start] -= 0.5
    if end in weights and end_half == "morning":
        weights[end] -= 0.5

    return {"days_count": max(sum(weights.values()), 0.0),
            "holidays": holidays_in_period, "saturdays_count": saturdays}


def _slot(d: date, half: str, is_end: bool) -> int:
    """Position d'une demi-journée sur une ligne de temps (pour détecter les chevauchements)."""
    return d.toordinal() * 2 + (0 if half == "morning" else 1)


# ==============================================================================
# SCHÉMAS
# ==============================================================================
Half = Literal["morning", "afternoon"]


class LoginRequest(BaseModel):
    email: str
    password: str


class PasswordChange(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8, max_length=128)


class UserCreate(BaseModel):
    matricule: str = Field(min_length=1, max_length=20)
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    birth_date: date                       # sert uniquement à fabriquer le mot de passe JJMM (non stocké)
    role: str = ROLE_EMPLOYEE
    confirm_order: Optional[int] = None
    statut: Optional[str] = None
    date_entree: Optional[date] = None
    droits_cp: float = Field(default=0.0, ge=0)
    droits_rtt: float = Field(default=0.0, ge=0)


class RoleUpdate(BaseModel):
    role: str
    confirm_order: Optional[int] = None


class RightsUpdate(BaseModel):
    droits_cp: Optional[float] = Field(default=None, ge=0, le=100)
    droits_fractionnement: Optional[float] = Field(default=None, ge=0, le=100)
    droits_rtt: Optional[float] = Field(default=None, ge=0, le=100)
    cp_deja_pris: Optional[float] = Field(default=None, ge=0, le=100)


class PasswordReset(BaseModel):
    new_password: str = Field(min_length=4, max_length=128)


class LeaveCreate(BaseModel):
    start_date: date
    start_half_day: Half = "morning"
    end_date: date
    end_half_day: Half = "afternoon"
    leave_type: str
    manager_id: Optional[int] = None       # choisi dans la liste déroulante ; None = directement la RH
    for_user_id: Optional[int] = None      # saisie POUR un autre salarié (RH ; formations pour la gestionnaire dédiée)
    employee_comment: Optional[str] = Field(default=None, max_length=500)


class JustificatifIn(BaseModel):
    recu: bool


class FixedManagerIn(BaseModel):
    manager_id: Optional[int] = None


class DecisionIn(BaseModel):
    status: Literal["approved", "rejected"]
    comment: Optional[str] = Field(default=None, max_length=500)


class UserBrief(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    full_name: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    matricule: str
    email: str
    full_name: str
    role: str
    confirm_order: Optional[int] = None
    statut: Optional[str] = None
    date_entree: Optional[date] = None
    is_active: bool
    is_manager: bool
    must_change_password: bool
    can_manage_training: bool = False
    fixed_manager_id: Optional[int] = None
    fixed_manager_name: Optional[str] = None
    droits_cp: float = 0.0
    droits_fractionnement: float = 0.0
    droits_rtt: float = 0.0
    cp_deja_pris: float = 0.0
    solde_cp: Optional[float] = None
    solde_rtt: Optional[float] = None
    samedis_utilises: int = 0


class StepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    position: int
    kind: str
    approver_id: Optional[int] = None
    approver_name: str
    status: str
    decided_by_name: Optional[str] = None
    decided_at: Optional[datetime] = None
    comment: Optional[str] = None


class JustifFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str
    size: int
    content_type: str
    uploaded_at: Optional[datetime] = None


class LeaveOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    start_date: date
    start_half_day: str
    end_date: date
    end_half_day: str
    days_count: float
    saturdays_count: int = 0
    leave_type: str
    status: str
    employee_comment: Optional[str] = None
    admin_comment: Optional[str] = None
    created_at: datetime
    manager_id: Optional[int] = None
    manager_name: Optional[str] = None
    decided_by_name: Optional[str] = None
    rh_seen: bool = False
    justificatif_requis: bool = False
    justificatif_recu: bool = False
    justificatifs: List[JustifFileOut] = []
    created_by_id: Optional[int] = None
    created_by_name: Optional[str] = None
    employee: UserOut
    steps: List[StepOut] = []
    awaiting_kind: Optional[str] = None
    awaiting_approver_id: Optional[int] = None
    awaiting_name: Optional[str] = None


# ==============================================================================
# NOTIFICATIONS (préparées dans la requête, envoyées après la réponse)
# ==============================================================================
def _admins(session: Session) -> List[db.User]:
    return session.query(db.User).filter(db.User.role == ROLE_ADMIN, db.User.is_active == True).all()  # noqa: E712


def _mail_html(title: str, leave: db.LeaveRequest, closing: str) -> str:
    e = _html.escape
    return f"""
    <div style="font-family: sans-serif; color: #1e293b;">
      <h2 style="color: #4f46e5;">{e(title)}</h2>
      <ul>
        <li><strong>Salarié :</strong> {e(leave.employee.full_name)} (n° {e(leave.employee.matricule)})</li>
        <li><strong>Type :</strong> {e(leave.leave_type)}</li>
        <li><strong>Période :</strong> du {leave.start_date:%d/%m/%Y} au {leave.end_date:%d/%m/%Y}</li>
        <li><strong>Durée décomptée :</strong> {leave.days_count} jour(s)</li>
        <li><strong>Manager choisi :</strong> {e(leave.manager_name or 'aucun (RH directement)')}</li>
        <li><strong>Motif :</strong> {e(leave.employee_comment or 'Non précisé')}</li>
      </ul>
      <p>{e(closing)}</p>
      {f'<p><a href="{e(APP_URL)}">Ouvrir le portail SAT Congés</a></p>' if APP_URL else ''}
    </div>"""


def _queue(bg: BackgroundTasks, mails: list):
    seen = set()
    for to, subject, body in mails:
        if to and (to, subject) not in seen:
            seen.add((to, subject))
            bg.add_task(send_email_notification, to, subject, body)


def _mails_for_step_change(session: Session, leave: db.LeaveRequest, prefix: str) -> list:
    """Qui prévenir après une création ou une décision : prochain valideur, salarié si terminé, RH toujours."""
    mails, name = [], leave.employee.full_name
    admins = _admins(session)
    step = leave.current_step
    if leave.status == "pending" and step:
        if step.kind == "rh":
            for a in admins:
                mails.append((a.email, f"[SAT Congés] {prefix}À valider (validation finale) - {name}",
                              _mail_html("Demande à valider", leave, "Vous êtes le dernier valideur : rendez-vous sur le portail.")))
        else:
            approver = session.get(db.User, step.approver_id)
            if approver:
                mails.append((approver.email, f"[SAT Congés] {prefix}À valider - {name}",
                              _mail_html("Demande à valider", leave, "Rendez-vous sur le portail SAT pour valider ou refuser cette demande.")))
            for a in admins:
                if a.id in (step.approver_id, leave.user_id):
                    continue
                mails.append((a.email, f"[SAT Congés] Info : demande de {name} en cours de validation ({step.approver_name})",
                              _mail_html("Information RH", leave, f"En attente de {step.approver_name}. Vous êtes simplement informé(e).")))
    else:
        verdict = "acceptée" if leave.status == "approved" else "refusée"
        mails.append((leave.employee.email, f"[SAT Congés] Votre demande a été {verdict}",
                      _mail_html(f"Votre demande a été {verdict}", leave, leave.admin_comment or "")))
        for a in admins:
            if a.id == leave.user_id:
                continue
            mails.append((a.email, f"[SAT Congés] Demande de {name} {verdict}",
                          _mail_html(f"Demande {verdict}", leave, "Information RH.")))
    return mails


# ==============================================================================
# CIRCUIT DE VALIDATION : manager choisi -> confirmateurs (ordre) -> RH
# ==============================================================================
def _christophe(session: Session) -> Optional[db.User]:
    return (session.query(db.User)
            .filter(db.User.matricule == db.CHRISTOPHE_MATRICULE, db.User.is_active == True)  # noqa: E712
            .first())


def build_steps(session: Session, requester: db.User, manager: Optional[db.User]):
    """
    Circuits :
      - Manager imposé (Assan -> Rachelle ; Claudia et Anissa -> RH) : manager imposé -> Christophe, RH notifiée.
      - Demande de la RH elle-même : Christophe uniquement, (autre RH éventuelle notifiée).
      - Manager qui pose un congé : Édouard -> Christophe (pas de choix de manager).
      - Standard : manager choisi -> Édouard -> Christophe (RH notifiée seulement) ; sans manager : RH directement.
    La RH est notifiée à chaque étape dans tous les cas (voir _mails_for_step_change).
    """
    chris = _christophe(session)

    if requester.fixed_manager_id:
        fm = requester.fixed_manager
        steps = [("manager", fm.id, fm.full_name)]
        if chris and chris.id != requester.id:
            steps.append(("confirm", chris.id, chris.full_name))
        return steps

    if requester.role == ROLE_ADMIN:
        if not chris:
            raise HTTPException(400, "Valideur Christophe introuvable.")
        return [("confirm", chris.id, chris.full_name)]

    if requester.role == ROLE_MANAGER:     # un manager ne choisit pas de manager : Édouard puis Christophe
        confirmers = (session.query(db.User)
                      .filter(db.User.role == ROLE_CONFIRMER, db.User.is_active == True)  # noqa: E712
                      .order_by(db.User.confirm_order, db.User.id).all())
        steps = [("confirm", c.id, c.full_name) for c in confirmers]
        if not steps:
            raise HTTPException(400, "Aucun valideur disponible pour cette demande.")
        return steps

    steps = []
    if manager:
        steps.append(("manager", manager.id, manager.full_name))
        confirmers = (session.query(db.User)
                      .filter(db.User.role == ROLE_CONFIRMER, db.User.is_active == True)  # noqa: E712
                      .order_by(db.User.confirm_order, db.User.id).all())
        steps += [("confirm", c.id, c.full_name) for c in confirmers]      # Édouard puis Christophe
    else:
        steps.append(("rh", None, "RH"))        # pas de manager choisi : la RH valide directement
    steps = [s for s in steps if s[1] != requester.id]   # personne ne valide sa propre demande
    if not steps:
        raise HTTPException(400, "Aucun valideur disponible pour cette demande.")
    return steps


# ==============================================================================
# ROUTES : GÉNÉRAL / AUTH
# ==============================================================================
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/holidays")
def get_french_holidays(year: int = Query(default=datetime.now().year, ge=2000, le=2100)):
    # Format attendu par le front : { "2026-12-25": "Noël", ... } sur 3 ans
    fr = holidays.France(years=[year - 1, year, year + 1], language="fr")
    return {d.isoformat(): name for d, name in fr.items()}


@app.post("/api/login")
def login(req: LoginRequest, session: Session = Depends(get_db)):
    key = req.email.strip().lower()
    security.check_throttle(key)
    user = session.query(db.User).filter(db.User.email == key).first()
    ok = security.verify_password(req.password, user.password_hash if user else None)
    if not (user and user.is_active and ok):
        security.register_fail(key)
        raise HTTPException(401, "Email ou mot de passe incorrect.")
    security.clear_fails(key)
    return {"token": security.create_token(user.id), "user": UserOut.model_validate(user)}


@app.get("/api/me", response_model=UserOut)
def me(user: db.User = Depends(current_user)):
    return user


@app.post("/api/change-password")
def change_password(req: PasswordChange, user: db.User = Depends(current_user), session: Session = Depends(get_db)):
    if not security.verify_password(req.old_password, user.password_hash):
        raise HTTPException(400, "Ancien mot de passe incorrect.")
    user.password_hash = security.hash_password(req.new_password)
    user.must_change_password = False
    session.commit()
    return {"ok": True}


# ==============================================================================
# ROUTES : UTILISATEURS
# ==============================================================================
@app.get("/api/managers", response_model=List[UserBrief])
def list_managers(user: db.User = Depends(current_user), session: Session = Depends(get_db)):
    """Liste déroulante « Manager / chantier » du formulaire de demande."""
    return (session.query(db.User)
            .filter(db.User.role == ROLE_MANAGER, db.User.is_active == True, db.User.id != user.id)  # noqa: E712
            .order_by(db.User.full_name).all())


@app.get("/api/users", response_model=List[UserOut])
def get_users(_: db.User = Depends(require_admin), session: Session = Depends(get_db)):
    return session.query(db.User).filter(db.User.is_active == True).order_by(db.User.full_name).all()  # noqa: E712


@app.post("/api/users", response_model=UserOut)
def create_user(req: UserCreate, _: db.User = Depends(require_admin), session: Session = Depends(get_db)):
    if req.role not in ALL_ROLES:
        raise HTTPException(400, "Rôle invalide.")
    email = req.email.strip().lower()
    if session.query(db.User).filter((db.User.email == email) | (db.User.matricule == req.matricule)).first():
        raise HTTPException(400, "Email ou matricule déjà utilisé.")
    user = db.User(
        matricule=req.matricule, email=email, full_name=req.full_name.strip(), role=req.role,
        confirm_order=req.confirm_order, statut=req.statut, date_entree=req.date_entree,
        droits_cp=req.droits_cp, droits_rtt=req.droits_rtt,
        password_hash=security.hash_password(f"{req.birth_date.day:02d}{req.birth_date.month:02d}"),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _get_user_or_404(session: Session, user_id: int) -> db.User:
    u = session.get(db.User, user_id)
    if not u:
        raise HTTPException(404, "Utilisateur introuvable.")
    return u


@app.patch("/api/users/{user_id}/role", response_model=UserOut)
def update_role(user_id: int, req: RoleUpdate, actor: db.User = Depends(require_admin), session: Session = Depends(get_db)):
    if req.role not in ALL_ROLES:
        raise HTTPException(400, "Rôle invalide.")
    u = _get_user_or_404(session, user_id)
    if u.role == ROLE_ADMIN and req.role != ROLE_ADMIN:
        others = session.query(db.User).filter(db.User.role == ROLE_ADMIN, db.User.is_active == True, db.User.id != u.id).count()  # noqa: E712
        if others == 0:
            raise HTTPException(400, "Il doit rester au moins un administrateur.")
    u.role = req.role
    u.confirm_order = req.confirm_order if req.role == ROLE_CONFIRMER else None
    session.commit()
    session.refresh(u)
    return u


@app.patch("/api/users/{user_id}/rights", response_model=UserOut)
def update_rights(user_id: int, req: RightsUpdate, _: db.User = Depends(require_admin), session: Session = Depends(get_db)):
    u = _get_user_or_404(session, user_id)
    for field in ("droits_cp", "droits_fractionnement", "droits_rtt"):
        value = getattr(req, field)
        if value is not None:
            setattr(u, field, value)
    if req.cp_deja_pris is not None:
        u.cp_deja_pris = req.cp_deja_pris
        u.cp_deja_pris_exercice = db.leave_year_bounds(date.today())[0].year
    session.commit()
    session.refresh(u)
    return u


@app.post("/api/users/{user_id}/reset-password")
def reset_password(user_id: int, req: PasswordReset, _: db.User = Depends(require_admin), session: Session = Depends(get_db)):
    u = _get_user_or_404(session, user_id)
    u.password_hash = security.hash_password(req.new_password)
    u.must_change_password = True
    session.commit()
    return {"ok": True}


@app.delete("/api/users/{user_id}")
def deactivate_user(user_id: int, actor: db.User = Depends(require_admin), session: Session = Depends(get_db)):
    """Désactivation (et non suppression) : l'historique des congés est conservé."""
    u = _get_user_or_404(session, user_id)
    if u.role == ROLE_ADMIN:
        raise HTTPException(400, "Un administrateur ne peut pas être désactivé.")
    u.is_active = False
    session.commit()
    return {"ok": True}


# ==============================================================================
# ROUTES : CONGÉS
# ==============================================================================
@app.get("/api/leaves/preview")
def preview_leave_days(start_date: date, end_date: date, start_half_day: Half = "morning",
                       end_half_day: Half = "afternoon", leave_type: str = "Congés Payés (CP)",
                       for_user_id: Optional[int] = None,
                       user: db.User = Depends(current_user), session: Session = Depends(get_db)):
    target = user
    if for_user_id and for_user_id != user.id and (user.role == ROLE_ADMIN or user.can_manage_training):
        target = session.get(db.User, for_user_id) or user
    saturdays_left = target.samedis_restants(start_date) if leave_type in db.CP_TYPES else None
    return calculate_working_days_details(start_date, end_date, start_half_day, end_half_day, leave_type, saturdays_left)


@app.get("/api/leaves/chain")
def preview_chain(manager_id: Optional[int] = None, user: db.User = Depends(current_user),
                  session: Session = Depends(get_db)):
    """Qui validera la demande, dans l'ordre (pour informer le salarié avant l'envoi)."""
    manager = None
    if user.fixed_manager_id:
        manager = user.fixed_manager
    elif user.role == ROLE_MANAGER:
        manager = None
    elif manager_id is not None:
        cand = session.get(db.User, manager_id)
        if cand and cand.role == ROLE_MANAGER and cand.is_active and cand.id != user.id:
            manager = cand
    return [{"kind": k, "approver_name": n} for k, _, n in build_steps(session, user, manager)]


@app.post("/api/leaves", response_model=LeaveOut)
def create_leave(req: LeaveCreate, bg: BackgroundTasks, actor: db.User = Depends(current_user),
                 session: Session = Depends(get_db)):
    if req.leave_type not in db.LEAVE_TYPES:
        raise HTTPException(400, "Type de congé inconnu.")
    if req.end_date < req.start_date:
        raise HTTPException(400, "La date de fin est antérieure à la date de début.")

    # Pour qui ? Soi-même (circuit de validation) ou un autre salarié (RH : tout type ; gestionnaire des formations : Formation)
    user, on_behalf = actor, False
    if req.for_user_id and req.for_user_id != actor.id:
        user = session.get(db.User, req.for_user_id)
        if not user or not user.is_active:
            raise HTTPException(404, "Salarié introuvable.")
        if not (actor.role == ROLE_ADMIN or (actor.can_manage_training and req.leave_type == "Formation")):
            raise HTTPException(403, "Tu ne peux saisir que des formations pour les autres salariés." if actor.can_manage_training
                                else "Réservé à la RH.")
        on_behalf = True

    s_new, e_new = _slot(req.start_date, req.start_half_day, False), _slot(req.end_date, req.end_half_day, True)
    if e_new < s_new:
        raise HTTPException(400, "Période incohérente (demi-journées).")
    for l in user.leaves:
        if l.status in db.BLOCKING_STATUSES and \
                _slot(l.start_date, l.start_half_day, False) <= e_new and s_new <= _slot(l.end_date, l.end_half_day, True):
            raise HTTPException(400, f"Cette période chevauche une demande existante ({l.start_date:%d/%m/%Y} → {l.end_date:%d/%m/%Y}).")

    manager = None
    if on_behalf or user.role == ROLE_MANAGER:
        manager = None                               # pas de choix de manager
    elif user.fixed_manager_id:
        manager = user.fixed_manager                 # le salarié ne choisit pas : on ignore req.manager_id
    elif req.manager_id is not None:
        manager = session.get(db.User, req.manager_id)
        if not manager or manager.role != ROLE_MANAGER or not manager.is_active or manager.id == user.id:
            raise HTTPException(400, "Manager invalide.")

    saturdays_left = user.samedis_restants(req.start_date) if req.leave_type in db.CP_TYPES else None
    details = calculate_working_days_details(req.start_date, req.end_date, req.start_half_day,
                                             req.end_half_day, req.leave_type, saturdays_left)
    days = details["days_count"]
    if days <= 0:
        raise HTTPException(400, "La période sélectionnée ne contient aucun jour ouvré (uniquement week-end ou jour férié).")

    solde = user.solde_for(req.leave_type, req.start_date)
    if solde is not None and days > solde:
        raise HTTPException(400, f"Le nombre de jours posés ({days}) est supérieur au solde disponible ({solde}).")

    leave = db.LeaveRequest(
        user_id=user.id, start_date=req.start_date, start_half_day=req.start_half_day,
        end_date=req.end_date, end_half_day=req.end_half_day, days_count=days,
        saturdays_count=details["saturdays_count"], leave_type=req.leave_type,
        employee_comment=req.employee_comment,
        manager_id=manager.id if manager else None, manager_name=manager.full_name if manager else None,
        rh_seen=False, created_by_id=actor.id, created_by_name=actor.full_name,
    )
    if on_behalf:
        # Saisie directe : pas de circuit de validation, l'absence est enregistrée (validée) tout de suite
        leave.status = "approved"
        leave.decided_by_id, leave.decided_by_name = actor.id, actor.full_name
        leave.admin_comment = f"Saisi par {actor.full_name}"
        leave.rh_seen = actor.role == ROLE_ADMIN
    else:
        for i, (kind, approver_id, approver_name) in enumerate(build_steps(session, user, manager), start=1):
            leave.steps.append(db.LeaveStep(position=i, kind=kind, approver_id=approver_id, approver_name=approver_name))
    session.add(leave)
    session.commit()
    session.refresh(leave)

    if on_behalf:
        mails = [(user.email, f"[SAT Congés] Une absence a été enregistrée pour vous",
                  _mail_html("Absence enregistrée", leave, f"Saisie par {actor.full_name}."))]
        if actor.role != ROLE_ADMIN:               # la RH est toujours informée
            mails += [(a.email, f"[SAT Congés] Info : {leave.leave_type} saisie pour {user.full_name} par {actor.full_name}",
                       _mail_html("Information RH", leave, f"Saisie par {actor.full_name}.")) for a in _admins(session)]
        _queue(bg, mails)
    else:
        _queue(bg, _mails_for_step_change(session, leave, prefix=""))
    return leave


@app.get("/api/leaves", response_model=List[LeaveOut])
def get_leaves(user_id: Optional[int] = None,
               justificatif: Optional[Literal["manquant", "depose", "recu"]] = None,
               leave_type: Optional[str] = None,
               actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    q = session.query(db.LeaveRequest)
    if leave_type:
        q = q.filter(db.LeaveRequest.leave_type == leave_type)
    if justificatif:     # filtre RH : manquant (rien reçu) / déposé (à vérifier) / reçu (validé par la RH)
        needing = [n for n, i in db.LEAVE_TYPE_INFO.items() if i["justificatif"]]
        has_file = exists().where(db.Justificatif.leave_id == db.LeaveRequest.id)
        q = q.filter(db.LeaveRequest.leave_type.in_(needing),
                     db.LeaveRequest.status.notin_(("rejected", "cancelled")))
        if justificatif == "recu":
            q = q.filter(db.LeaveRequest.justificatif_recu == True)  # noqa: E712
        elif justificatif == "depose":
            q = q.filter(db.LeaveRequest.justificatif_recu == False, has_file)  # noqa: E712
        else:
            q = q.filter(db.LeaveRequest.justificatif_recu == False, ~has_file)  # noqa: E712
    if actor.role == ROLE_ADMIN:
        if user_id:
            q = q.filter(db.LeaveRequest.user_id == user_id)
    else:
        q = q.filter(db.LeaveRequest.user_id == actor.id)       # un salarié ne voit que SES demandes
    return q.order_by(db.LeaveRequest.created_at.desc()).all()


@app.get("/api/leaves/assigned", response_model=List[LeaveOut])
def assigned_leaves(actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    """Demandes où je suis valideur (manager choisi ou valideur de confirmation), en attente ou traitées."""
    q = (session.query(db.LeaveRequest).join(db.LeaveStep, db.LeaveStep.leave_id == db.LeaveRequest.id)
         .filter(db.LeaveStep.approver_id == actor.id).distinct())
    return q.order_by(db.LeaveRequest.created_at.desc()).all()


@app.patch("/api/leaves/{leave_id}/decision", response_model=LeaveOut)
def decide_leave(leave_id: int, req: DecisionIn, bg: BackgroundTasks,
                 actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    leave = session.get(db.LeaveRequest, leave_id)
    if not leave:
        raise HTTPException(404, "Demande introuvable.")
    step = leave.current_step
    if leave.status != "pending" or not step:
        raise HTTPException(400, "Cette demande n'est plus en attente.")
    if actor.id == leave.user_id:
        raise HTTPException(403, "Tu ne peux pas valider ta propre demande.")
    if not (actor.role == ROLE_ADMIN or actor.id == step.approver_id):
        raise HTTPException(403, "Ce n'est pas à toi de valider cette étape.")

    step.status, step.decided_by_id, step.decided_by_name = req.status, actor.id, actor.full_name
    step.decided_at, step.comment = datetime.utcnow(), req.comment
    leave.decided_by_id, leave.decided_by_name, leave.admin_comment = actor.id, actor.full_name, req.comment
    leave.rh_seen = actor.role == ROLE_ADMIN

    if req.status == "rejected":
        leave.status = "rejected"
    elif all(s.status == "approved" for s in leave.steps):
        leave.status = "approved"
    session.commit()
    session.refresh(leave)

    _queue(bg, _mails_for_step_change(session, leave, prefix=""))
    return leave


@app.patch("/api/leaves/{leave_id}/cancel", response_model=LeaveOut)
def cancel_leave(leave_id: int, actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    leave = session.get(db.LeaveRequest, leave_id)
    if not leave:
        raise HTTPException(404, "Demande introuvable.")
    allowed = ("pending", "approved") if actor.role == ROLE_ADMIN else ("pending",)
    trainer_entry = (actor.can_manage_training and leave.created_by_id == actor.id
                     and leave.leave_type == "Formation" and leave.user_id != actor.id)
    if trainer_entry:
        allowed = ("pending", "approved")
    if not (actor.role == ROLE_ADMIN or leave.user_id == actor.id or trainer_entry) or leave.status not in allowed:
        raise HTTPException(403, "Annulation impossible.")
    leave.status = "cancelled"     # libère automatiquement les jours du solde
    session.commit()
    session.refresh(leave)
    return leave


@app.patch("/api/leaves/{leave_id}/seen", response_model=LeaveOut)
def mark_leave_seen(leave_id: int, _: db.User = Depends(require_admin), session: Session = Depends(get_db)):
    leave = session.get(db.LeaveRequest, leave_id)
    if not leave:
        raise HTTPException(404, "Demande introuvable.")
    leave.rh_seen = True
    session.commit()
    session.refresh(leave)
    return leave


@app.get("/api/leave-types")
def leave_types(_: db.User = Depends(current_user)):
    """Types de congés avec code, couleur et indicateurs (pour le formulaire, le calendrier, les filtres)."""
    return [{"name": n, **info, "counts_balance": n in db.CP_TYPES or n in db.RTT_TYPES}
            for n, info in db.LEAVE_TYPE_INFO.items()]


@app.patch("/api/leaves/{leave_id}/justificatif", response_model=LeaveOut)
def set_justificatif(leave_id: int, req: JustificatifIn, _: db.User = Depends(require_admin),
                     session: Session = Depends(get_db)):
    leave = session.get(db.LeaveRequest, leave_id)
    if not leave:
        raise HTTPException(404, "Demande introuvable.")
    leave.justificatif_recu = req.recu
    session.commit()
    session.refresh(leave)
    return leave


@app.patch("/api/users/{user_id}/fixed-manager", response_model=UserOut)
def set_fixed_manager(user_id: int, req: FixedManagerIn, _: db.User = Depends(require_admin),
                      session: Session = Depends(get_db)):
    u = _get_user_or_404(session, user_id)
    if req.manager_id is not None:
        m = _get_user_or_404(session, req.manager_id)
        if m.id == u.id:
            raise HTTPException(400, "Un salarié ne peut pas être son propre manager.")
    u.fixed_manager_id = req.manager_id
    session.commit()
    session.refresh(u)
    return u


def _parse_month(value: str) -> date:
    try:
        y, mo = value.split("-")
        return date(int(y), int(mo), 1)
    except Exception:
        raise HTTPException(400, "Mois invalide (format AAAA-MM).")


@app.get("/api/export/planning")
def export_planning_xlsx(start: str, end: str, user_ids: Optional[str] = None,
                         _: db.User = Depends(require_admin), session: Session = Depends(get_db)):
    """Excel du planning (grille colorée avec demi-journées) pour une période de mois et les salariés choisis."""
    first, last = _parse_month(start), _parse_month(end)
    if last < first:
        raise HTTPException(400, "Le mois de fin précède le mois de début.")
    end_excl = date(last.year + (last.month // 12), last.month % 12 + 1, 1)
    if (end_excl - first).days > 800:
        raise HTTPException(400, "Période trop longue (24 mois maximum).")
    q = session.query(db.User).filter(db.User.is_active == True)  # noqa: E712
    if user_ids:
        try:
            ids = [int(x) for x in user_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(400, "Liste de salariés invalide.")
        q = q.filter(db.User.id.in_(ids))
    users = q.order_by(db.User.full_name).all()
    if not users:
        raise HTTPException(404, "Aucun salarié sélectionné.")
    data = export_planning.build_workbook(users, first, end_excl)
    return Response(content=data,
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="planning_SAT_{start}_{end}.xlsx"'})


def _sniff(data: bytes):
    """Type réel du fichier d'après son contenu (et non son nom) : PDF, JPG ou PNG uniquement."""
    if data.startswith(b"%PDF-"):
        return "application/pdf", ".pdf"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png", ".png"
    return None


def _safe_name(name: str, ext: str) -> str:
    base = os.path.splitext(os.path.basename(name or "justificatif"))[0]
    base = "".join(ch if ch.isalnum() or ch in "-_ ." else "_" for ch in base).strip(" ._")[:80] or "justificatif"
    return base + ext


@app.post("/api/leaves/{leave_id}/justificatifs", response_model=LeaveOut)
def upload_justificatif(leave_id: int, bg: BackgroundTasks, file: UploadFile = File(...),
                        actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    leave = session.get(db.LeaveRequest, leave_id)
    if not leave:
        raise HTTPException(404, "Demande introuvable.")
    if not (leave.user_id == actor.id or actor.role == ROLE_ADMIN):
        raise HTTPException(403, "Accès refusé.")
    if leave.status in ("rejected", "cancelled"):
        raise HTTPException(400, "Cette demande est refusée ou annulée.")
    if len(leave.justificatifs) >= db.MAX_JUSTIF_PER_LEAVE:
        raise HTTPException(400, f"Maximum {db.MAX_JUSTIF_PER_LEAVE} fichiers par demande.")
    data = file.file.read(db.MAX_JUSTIF_BYTES + 1)
    if len(data) > db.MAX_JUSTIF_BYTES:
        raise HTTPException(413, "Fichier trop lourd (5 Mo maximum).")
    kind = _sniff(data)
    if not kind:
        raise HTTPException(400, "Format non accepté : PDF, JPG ou PNG uniquement.")
    leave.justificatifs.append(db.Justificatif(
        filename=_safe_name(file.filename, kind[1]), content_type=kind[0], size=len(data),
        data=data, uploaded_by_id=actor.id))
    session.commit()
    session.refresh(leave)

    if actor.role != ROLE_ADMIN:    # la RH est prévenue qu'un justificatif est arrivé
        e = _html.escape
        body = (f"<p>{e(leave.employee.full_name)} a déposé un justificatif pour sa demande "
                f"« {e(leave.leave_type)} » du {leave.start_date:%d/%m/%Y} au {leave.end_date:%d/%m/%Y}.</p>"
                + (f'<p><a href="{e(APP_URL)}">Ouvrir le portail SAT Congés</a></p>' if APP_URL else ""))
        _queue(bg, [(a.email, f"[SAT Congés] Justificatif déposé - {leave.employee.full_name}", body) for a in _admins(session)])
    return leave


def _justif_or_404(session: Session, justif_id: int, actor: db.User) -> db.Justificatif:
    j = session.get(db.Justificatif, justif_id)
    # Données médicales : uniquement le salarié concerné et la RH (même pas les managers)
    if not j or not (actor.role == ROLE_ADMIN or j.leave.user_id == actor.id):
        raise HTTPException(404, "Justificatif introuvable.")
    return j


@app.get("/api/justificatifs/{justif_id}")
def download_justificatif(justif_id: int, actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    j = _justif_or_404(session, justif_id, actor)
    return Response(content=j.data, media_type=j.content_type,
                    headers={"Content-Disposition": f'inline; filename="{j.filename}"',
                             "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@app.delete("/api/justificatifs/{justif_id}", response_model=LeaveOut)
def delete_justificatif(justif_id: int, actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    j = _justif_or_404(session, justif_id, actor)
    leave = j.leave
    if actor.role != ROLE_ADMIN and leave.justificatif_recu:
        raise HTTPException(403, "Justificatif déjà validé par la RH : suppression impossible.")
    session.delete(j)
    session.commit()
    session.refresh(leave)
    return leave


class DirectoryEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    matricule: str
    full_name: str


class TrainingOut(BaseModel):
    id: int
    user_id: int
    matricule: str
    employee_name: str
    start_date: date
    start_half_day: str
    end_date: date
    end_half_day: str
    days_count: float
    status: str


@app.get("/api/directory", response_model=List[DirectoryEntry])
def directory(actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    """Nom + matricule uniquement, pour choisir « pour qui » saisir une absence (RH, gestionnaire des formations)."""
    if not (actor.role == ROLE_ADMIN or actor.can_manage_training):
        raise HTTPException(403, "Accès refusé.")
    return (session.query(db.User).filter(db.User.is_active == True)  # noqa: E712
            .order_by(db.User.full_name).all())


@app.get("/api/trainings", response_model=List[TrainingOut])
def my_trainings(actor: db.User = Depends(current_user), session: Session = Depends(get_db)):
    """Formations saisies par la gestionnaire (son seul écran : elle ne voit rien d'autre)."""
    if not actor.can_manage_training:
        raise HTTPException(403, "Accès refusé.")
    rows = (session.query(db.LeaveRequest)
            .filter(db.LeaveRequest.created_by_id == actor.id, db.LeaveRequest.leave_type == "Formation",
                    db.LeaveRequest.user_id != actor.id, db.LeaveRequest.status != "cancelled")
            .order_by(db.LeaveRequest.start_date.desc()).all())
    return [TrainingOut(id=l.id, user_id=l.user_id, matricule=l.employee.matricule, employee_name=l.employee.full_name,
                        start_date=l.start_date, start_half_day=l.start_half_day, end_date=l.end_date,
                        end_half_day=l.end_half_day, days_count=l.days_count, status=l.status) for l in rows]