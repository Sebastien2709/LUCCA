import os
from datetime import datetime, date

from sqlalchemy import (create_engine, Column, Integer, String, Float, Date, DateTime,
                        Boolean, ForeignKey, LargeBinary)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship, deferred

# ==============================================================================
# CONNEXION BASE DE DONNÉES
# En production : variable d'environnement DATABASE_URL (PostgreSQL, ex. Neon).
# En local, sans variable : fichier SQLite de test.
# ==============================================================================
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./sat_hr.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg2://", 1)

_is_sqlite = DATABASE_URL.startswith("sqlite")
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    pool_pre_ping=True,      # Neon met la base en veille : on teste la connexion avant usage
    pool_recycle=300,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ==============================================================================
# RÈGLES DE CONGÉS SAT
# ==============================================================================
LEAVE_YEAR_START_MONTH = 5                      # exercice : 1er mai -> 30 avril
CP_TYPES = {"Congés Payés (CP)", "CP"}          # jours OUVRABLES (lundi -> samedi)
RTT_TYPES = {"RTT"}                             # jours ouvrés (lundi -> vendredi)
MAX_SAMEDIS_PAR_EXERCICE = 5
BLOCKING_STATUSES = ("pending", "approved")     # statuts qui consomment le solde

# code = abréviation (Excel), color = couleur du calendrier/planning (hex sans #),
# justificatif = la RH doit recevoir un justificatif (filtre « justificatif » côté RH).
LEAVE_TYPE_INFO = {
    "Congés Payés (CP)":  {"code": "CP",  "color": "6B4FD8", "justificatif": False},
    "RTT":                {"code": "RTT", "color": "10B981", "justificatif": False},   # vert (ex-couleur du télétravail, supprimé)
    "Arrêt Maladie":      {"code": "AM",  "color": "EF4444", "justificatif": True},
    "Congé Sans Solde":   {"code": "CSS", "color": "64748B", "justificatif": False},
    "Événement familial": {"code": "EF",  "color": "EC4899", "justificatif": True},
    "Visite médicale":    {"code": "VM",  "color": "F97316", "justificatif": True},
    "Formation":          {"code": "FOR", "color": "EAB308", "justificatif": False},
}
LEAVE_TYPES = set(LEAVE_TYPE_INFO)

MAX_JUSTIF_BYTES = 5 * 1024 * 1024     # 5 Mo par fichier
MAX_JUSTIF_PER_LEAVE = 5

# Valideur de confirmation « final » utilisé dans les circuits d'exception (Christophe GORGEON)
CHRISTOPHE_MATRICULE = "213"

# Rôles
ROLE_EMPLOYEE = "employee"    # salarié
ROLE_MANAGER = "manager"      # chef de chantier : choisi dans la liste déroulante, valide en 1er
ROLE_CONFIRMER = "confirmer"  # valideur de confirmation (Édouard puis Christophe, selon confirm_order)
ROLE_ADMIN = "admin"          # RH : valideur final, reçoit toutes les notifications
ALL_ROLES = {ROLE_EMPLOYEE, ROLE_MANAGER, ROLE_CONFIRMER, ROLE_ADMIN}


def leave_year_bounds(ref: date):
    """Début et fin (exclue) de l'exercice de congés qui contient `ref`."""
    start = date(ref.year if ref.month >= LEAVE_YEAR_START_MONTH else ref.year - 1,
                 LEAVE_YEAR_START_MONTH, 1)
    return start, date(start.year + 1, LEAVE_YEAR_START_MONTH, 1)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    matricule = Column(String, unique=True, index=True, nullable=False)   # clé commune Sage / planning
    email = Column(String, unique=True, index=True, nullable=False)       # identifiant de connexion
    full_name = Column(String, nullable=False)
    role = Column(String, default=ROLE_EMPLOYEE, nullable=False)
    confirm_order = Column(Integer, nullable=True)                        # 1, 2... pour les valideurs de confirmation
    statut = Column(String, nullable=True)                                # Cadre / Ouvrier
    date_entree = Column(Date, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)

    password_hash = Column(String, nullable=False)
    must_change_password = Column(Boolean, default=False, nullable=False)

    # Droits de l'exercice en cours (saisis / ajustés par la RH)
    droits_cp = Column(Float, default=0.0)                # total CP (24 + 6 + ancienneté)
    droits_fractionnement = Column(Float, default=0.0)
    droits_rtt = Column(Float, default=0.0)
    # Reprise de l'existant : CP déjà consommés avant la mise en service de l'app (planning Excel)
    cp_deja_pris = Column(Float, default=0.0)
    cp_deja_pris_exercice = Column(Integer, nullable=True)  # année de début de l'exercice concerné (ex. 2026)

    # Peut saisir des FORMATIONS pour les autres (Anissa) : onglet dédié, ne voit rien d'autre
    can_manage_training = Column(Boolean, default=False, nullable=False)

    # Manager IMPOSÉ (le salarié ne choisit pas) : circuit court manager imposé -> Christophe -> RH notifiée
    fixed_manager_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    fixed_manager = relationship("User", remote_side=[id], foreign_keys=[fixed_manager_id])

    leaves = relationship("LeaveRequest", back_populates="employee", foreign_keys="LeaveRequest.user_id")

    @property
    def fixed_manager_name(self):
        return self.fixed_manager.full_name if self.fixed_manager else None

    @property
    def is_manager(self):
        return self.role == ROLE_MANAGER

    def solde_for(self, leave_type: str, ref_date: date):
        """Solde disponible sur l'exercice de `ref_date`. None = type sans plafond."""
        if leave_type in CP_TYPES:
            droits = (self.droits_cp or 0.0) + (self.droits_fractionnement or 0.0)
            types = CP_TYPES
        elif leave_type in RTT_TYPES:
            droits, types = (self.droits_rtt or 0.0), RTT_TYPES
        else:
            return None
        start, end = leave_year_bounds(ref_date)
        used = sum(
            l.days_count for l in self.leaves
            if l.leave_type in types and l.status in BLOCKING_STATUSES and start <= l.start_date < end
        )
        if leave_type in CP_TYPES and self.cp_deja_pris_exercice == start.year:
            used += self.cp_deja_pris or 0.0
        return round(droits - used, 2)

    def samedis_restants(self, ref_date: date) -> int:
        start, end = leave_year_bounds(ref_date)
        used = sum(
            (l.saturdays_count or 0) for l in self.leaves
            if l.leave_type in CP_TYPES and l.status in BLOCKING_STATUSES and start <= l.start_date < end
        )
        return max(0, MAX_SAMEDIS_PAR_EXERCICE - int(used))

    @property
    def samedis_utilises(self):
        return MAX_SAMEDIS_PAR_EXERCICE - self.samedis_restants(date.today())

    @property
    def solde_cp(self):
        return self.solde_for("CP", date.today())

    @property
    def solde_rtt(self):
        return self.solde_for("RTT", date.today())


class LeaveRequest(Base):
    __tablename__ = "leave_requests"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    start_date = Column(Date, nullable=False)
    start_half_day = Column(String, default="morning")
    end_date = Column(Date, nullable=False)
    end_half_day = Column(String, default="afternoon")
    days_count = Column(Float, nullable=False)
    saturdays_count = Column(Integer, default=0)
    leave_type = Column(String, nullable=False)
    status = Column(String, default="pending")        # pending / approved / rejected / cancelled
    employee_comment = Column(String, nullable=True)
    admin_comment = Column(String, nullable=True)     # dernier commentaire de décision
    created_at = Column(DateTime, default=datetime.utcnow)

    # Manager choisi par le salarié dans la liste déroulante (None = directement la RH)
    manager_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    manager_name = Column(String, nullable=True)
    decided_by_id = Column(Integer, nullable=True)
    decided_by_name = Column(String, nullable=True)
    rh_seen = Column(Boolean, default=False)          # notification RH lue ?
    justificatif_recu = Column(Boolean, default=False)  # la RH a reçu le justificatif
    created_by_id = Column(Integer, nullable=True)       # qui a saisi la demande (le salarié, la RH ou la gestionnaire des formations)
    created_by_name = Column(String, nullable=True)

    @property
    def justificatif_requis(self):
        return LEAVE_TYPE_INFO.get(self.leave_type, {}).get("justificatif", False)

    employee = relationship("User", back_populates="leaves", foreign_keys=[user_id])
    steps = relationship("LeaveStep", back_populates="leave", order_by="LeaveStep.position",
                         cascade="all, delete-orphan")
    justificatifs = relationship("Justificatif", back_populates="leave", order_by="Justificatif.id",
                                 cascade="all, delete-orphan", lazy="selectin")

    @property
    def current_step(self):
        if self.status != "pending":
            return None
        for s in self.steps:
            if s.status == "pending":
                return s
        return None

    @property
    def awaiting_kind(self):
        s = self.current_step
        return s.kind if s else None

    @property
    def awaiting_approver_id(self):
        s = self.current_step
        return s.approver_id if s else None

    @property
    def awaiting_name(self):
        s = self.current_step
        return s.approver_name if s else None


class LeaveStep(Base):
    """Une étape du circuit de validation : manager -> confirmation(s) -> RH."""
    __tablename__ = "leave_steps"

    id = Column(Integer, primary_key=True)
    leave_id = Column(Integer, ForeignKey("leave_requests.id"), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    kind = Column(String, nullable=False)                 # "manager" | "confirm" | "rh"
    approver_id = Column(Integer, ForeignKey("users.id"), nullable=True)   # None pour "rh" (tout admin)
    approver_name = Column(String, nullable=False)
    status = Column(String, default="pending")            # pending / approved / rejected
    decided_by_id = Column(Integer, nullable=True)
    decided_by_name = Column(String, nullable=True)
    decided_at = Column(DateTime, nullable=True)
    comment = Column(String, nullable=True)

    leave = relationship("LeaveRequest", back_populates="steps")


class Justificatif(Base):
    """Pièce jointe (PDF/JPG/PNG) d'une demande. Visible uniquement par le salarié et la RH."""
    __tablename__ = "justificatifs"

    id = Column(Integer, primary_key=True)
    leave_id = Column(Integer, ForeignKey("leave_requests.id"), nullable=False, index=True)
    filename = Column(String, nullable=False)
    content_type = Column(String, nullable=False)
    size = Column(Integer, nullable=False)
    data = deferred(Column(LargeBinary, nullable=False))      # chargé seulement au téléchargement
    uploaded_by_id = Column(Integer, nullable=True)
    uploaded_at = Column(DateTime, default=datetime.utcnow)

    leave = relationship("LeaveRequest", back_populates="justificatifs")