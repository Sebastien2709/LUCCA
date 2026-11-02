import os, smtplib, logging
from email.message import EmailMessage

log = logging.getLogger("sat")

# Tout vient des variables d'environnement : AUCUN secret dans le code.
SMTP_ENABLED = os.environ.get("SMTP_ENABLED", "false").lower() == "true"
SMTP_SERVER = os.environ.get("SMTP_SERVER", "smtp.office365.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")


def send_email_notification(to_email: str, subject: str, html_body: str):
    print(f"\n📧 [NOTIFICATION -> {to_email}] {subject}")
    if not SMTP_ENABLED:
        print("   Mode simulation (SMTP_ENABLED=false) : email non envoyé.\n")
        return
    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = f"SAT Congés <{SMTP_USER}>"
        msg["To"] = to_email
        msg.set_content("Veuillez activer l'affichage HTML pour lire cet email.")
        msg.add_alternative(html_body, subtype="html")
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=20) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.send_message(msg)
        print("   ✅ Email envoyé.\n")
    except Exception as e:
        log.error("Erreur envoi email vers %s : %s", to_email, e)