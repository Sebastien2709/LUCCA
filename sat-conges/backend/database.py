from sqlalchemy import create_engine, Column, Integer, String, Float, Date, DateTime, ForeignKey, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from datetime import datetime, date

SQLALCHEMY_DATABASE_URL = "sqlite:///./sat_hr.db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

# ==============================================================================
# RÈGLES DE CONGÉS SAT (à ajuster ici si besoin)
# ==============================================================================
# Exercice de congés : du 1er mai au 30 avril (la RH crédite les droits en avril
# pour que les salariés puissent les poser dès le 1er mai).
LEAVE_YEAR_START_MONTH = 5

# Noms EXACTS des types tels qu'envoyés par le front (App.jsx).
CP_TYPES = {"Congés Payés (CP)", "CP"}   # comptés en jours OUVRABLES (lundi -> samedi)
RTT_TYPES = {"RTT"}                      # comptés en jours ouvrés (lundi -> vendredi)

# Dans les 30 jours de CP, pas plus de 5 samedis décomptés par exercice
# (30 jours = au moins 25 jours de semaine réellement posés).
MAX_SAMEDIS_PAR_EXERCICE = 5

# Ces statuts consomment le solde (un refus libère automatiquement les jours).
BLOCKING_STATUSES = ("pending", "approved")


def leave_year_bounds(ref: date):
    """Début et fin de l'exercice de congés qui contient la date `ref`."""
    if ref.month >= LEAVE_YEAR_START_MONTH:
        start = date(ref.year, LEAVE_YEAR_START_MONTH, 1)
    else:
        start = date(ref.year - 1, LEAVE_YEAR_START_MONTH, 1)
    end = date(start.year + 1, LEAVE_YEAR_START_MONTH, 1)
    return start, end  # fin EXCLUE (1er mai suivant)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    full_name = Column(String, nullable=False)
    role = Column(String, default="employee")  # "employee" ou "admin"
    # Droits de l'exercice en cours (ex: 30 = 24 principale + 6 de 5e semaine, +0 à 3 d'ancienneté)
    # Tout est saisi par la RH (onglet Collaborateurs) : CP, fractionnement, RTT.
    droits_cp = Column(Float, default=30.0)
    droits_fractionnement = Column(Float, default=0.0)  # jours de fractionnement, ajoutés aux CP
    droits_rtt = Column(Float, default=0.0)             # 0 tant que la RH n'a pas crédité de RTT
    leaves = relationship("LeaveRequest", back_populates="employee")

    # --- Soldes CALCULÉS (jamais stockés) : droits - jours validés ou en attente ---
    def solde_for(self, leave_type: str, ref_date: date):
        """Solde disponible pour ce type sur l'exercice de `ref_date`. None = type sans plafond."""
        if leave_type in CP_TYPES:
            droits, types = (self.droits_cp or 0.0) + (self.droits_fractionnement or 0.0), CP_TYPES
        elif leave_type in RTT_TYPES:
            droits, types = self.droits_rtt, RTT_TYPES
        else:
            return None
        start, end = leave_year_bounds(ref_date)
        used = sum(
            l.days_count for l in self.leaves
            if l.leave_type in types and l.status in BLOCKING_STATUSES and start <= l.start_date < end
        )
        return round((droits or 0.0) - used, 2)

    def samedis_restants(self, ref_date: date) -> int:
        """Nombre de samedis encore décomptables sur l'exercice de `ref_date`."""
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
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    start_date = Column(Date, nullable=False)
    start_half_day = Column(String, default="morning")  # "morning" (matin) ou "afternoon" (après-midi)
    end_date = Column(Date, nullable=False)
    end_half_day = Column(String, default="afternoon")  # "morning" ou "afternoon"
    days_count = Column(Float, nullable=False)          # Calculé automatiquement (ex: 4.5 jours)
    saturdays_count = Column(Integer, default=0)        # Nombre de samedis décomptés dans cette demande
    leave_type = Column(String, nullable=False)
    status = Column(String, default="pending")          # "pending", "approved", "rejected"
    employee_comment = Column(String, nullable=True)
    admin_comment = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    employee = relationship("User", back_populates="leaves")


def ensure_columns():
    """Ajoute les nouvelles colonnes à une ancienne base SQLite (évite de la supprimer)."""
    lcols = {c["name"] for c in inspect(engine).get_columns("leave_requests")}
    with engine.begin() as conn:
        if "saturdays_count" not in lcols:
            conn.execute(text("ALTER TABLE leave_requests ADD COLUMN saturdays_count INTEGER DEFAULT 0"))
    cols = {c["name"] for c in inspect(engine).get_columns("users")}
    with engine.begin() as conn:
        if "droits_cp" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN droits_cp FLOAT DEFAULT 30"))
        if "droits_rtt" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN droits_rtt FLOAT DEFAULT 0"))
        if "droits_fractionnement" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN droits_fractionnement FLOAT DEFAULT 0"))