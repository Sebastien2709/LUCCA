import os, time, secrets, logging
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import HTTPException

log = logging.getLogger("sat")

SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    SECRET_KEY = secrets.token_urlsafe(48)
    log.warning("SECRET_KEY absent : clé temporaire générée (les connexions sautent à chaque redémarrage). "
                "Définis SECRET_KEY dans les variables d'environnement.")
ALGO = "HS256"
TOKEN_HOURS = int(os.environ.get("TOKEN_HOURS", "12"))


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


_DUMMY_HASH = hash_password("dummy-password")


def verify_password(password: str, hashed: str | None) -> bool:
    """Temps de calcul identique que le compte existe ou non (évite de révéler les emails valides)."""
    ok = bcrypt.checkpw(password.encode(), (hashed or _DUMMY_HASH).encode())
    return bool(hashed) and ok


def create_token(user_id: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=TOKEN_HOURS)
    return jwt.encode({"sub": str(user_id), "exp": exp}, SECRET_KEY, algorithm=ALGO)


def decode_token(token: str) -> int:
    payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGO])
    return int(payload["sub"])


# --- Anti-devinette : les mots de passe JJMM n'ont que 366 combinaisons possibles ---
MAX_FAILS = 5
WINDOW_SECONDS = 15 * 60
_fails: dict[str, list[float]] = {}


def _recent(key: str) -> list[float]:
    now = time.time()
    _fails[key] = [t for t in _fails.get(key, []) if now - t < WINDOW_SECONDS]
    return _fails[key]


def check_throttle(key: str):
    if len(_recent(key)) >= MAX_FAILS:
        raise HTTPException(429, "Trop de tentatives. Réessaie dans 15 minutes.")


def register_fail(key: str):
    _recent(key).append(time.time())


def clear_fails(key: str):
    _fails.pop(key, None)