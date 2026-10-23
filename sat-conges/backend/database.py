from sqlalchemy import create_engine, Column, Integer, String, Float, Date, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from datetime import datetime

SQLALCHEMY_DATABASE_URL = "sqlite:///./sat_hr.db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    full_name = Column(String, nullable=False)
    role = Column(String, default="employee")  # "employee" ou "admin"
    solde_cp = Column(Float, default=25.0) 
    solde_rtt = Column(Float, default=10.0)
    leaves = relationship("LeaveRequest", back_populates="employee")


class LeaveRequest(Base):
    __tablename__ = "leave_requests"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    start_date = Column(Date, nullable=False)
    start_half_day = Column(String, default="morning")  # "morning" (matin) ou "afternoon" (après-midi)
    end_date = Column(Date, nullable=False)
    end_half_day = Column(String, default="afternoon")  # "morning" ou "afternoon"
    days_count = Column(Float, nullable=False)          # Calculé automatiquement (ex: 4.5 jours)
    leave_type = Column(String, nullable=False)         # "CP", "RTT", "Sans solde", "Maladie"
    status = Column(String, default="pending")          # "pending", "approved", "rejected"
    employee_comment = Column(String, nullable=True)
    admin_comment = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    employee = relationship("User", back_populates="leaves")