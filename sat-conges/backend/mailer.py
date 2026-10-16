import smtplib
from email.message import EmailMessage

# ==============================================================================
# CONFIGURATION EMAIL (À activer quand tu auras les accès mail de SAT)
# ==============================================================================
SMTP_ENABLED = False  # Passe à True pour envoyer de vrais mails !
SMTP_SERVER = "smtp.office365.com"  # Ou "smtp.gmail.com" / serveur OVH de SAT
SMTP_PORT = 587
SMTP_USER = "sebastien.germano@edu..esiee.fr"
SMTP_PASSWORD = "Sgermano@2709seb"  # À sécuriser dans un vrai projet (variables d'environnement, vault, etc.)


def send_email_notification(to_email: str, subject: str, html_body: str):
    # Toujours afficher un résumé propre dans le terminal pour le suivi
    print(f"\n📧 [NOTIFICATION EMAIL -> {to_email}]")
    print(f"Sujet : {subject}")

    if not SMTP_ENABLED:
        print("Mode simulation actif (SMTP_ENABLED = False). Email non envoyé sur le réseau.\n")
        return

    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = f"SAT Congés <{SMTP_USER}>"
        msg["To"] = to_email
        msg.set_content("Veuillez activer l'affichage HTML pour lire cet email.")
        msg.add_alternative(html_body, subtype="html")

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.send_message(msg)
            print("✅ Email envoyé avec succès via SMTP !\n")
    except Exception as e:
        print(f"❌ Erreur lors de l'envoi de l'email : {e}\n")