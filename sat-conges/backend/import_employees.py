"""
Import initial des salariés SAT depuis les 3 fichiers Excel.

  Simulation (ne modifie rien) :  python import_employees.py
  Écriture réelle en base      :  python import_employees.py --apply

La base visée est celle de DATABASE_URL (Neon en production, SQLite sinon).
Les mots de passe initiaux (JJMM de la date de naissance) sont chiffrés (bcrypt) :
les dates de naissance ne sont PAS conservées en base.
Relancer le script est sans danger : un salarié existant (même matricule) n'est jamais dupliqué,
et ses droits / mot de passe ne sont pas écrasés.
"""
import argparse, re, sys
from datetime import datetime, date

import openpyxl
import xlrd

import database as db
import security

# ---------------------------------------------------------------- RÈGLES SAT
EXCLUS = {"300", "306", "282"}                     # sortis / en arrêt maladie longue durée
MANAGERS = {"214", "241", "230", "269", "296", "290", "272", "313"}
CONFIRMEURS = {"253": 1, "213": 2}                  # Édouard MARTIN puis Christophe GORGEON
ADMINS = {"234"}                                    # Jesfine GERMANO (RH)
TRAINERS = {"292"}                                  # Anissa TAHARI : saisit les formations des autres (n'a pas d'autre accès)
# Managers IMPOSÉS (le salarié ne choisit pas) : salarié -> matricule du manager.
# Circuit : manager imposé -> Christophe -> RH notifiée.
ASSAN_MATRICULE = "317"   # BOUHACINE Hacène (« Assan »)
FIXED_MANAGERS = {"259": "234",    # Claudia MARTINS REBELO  -> RH (Jesfine)
                  "292": "234"}    # Anissa TAHARI           -> RH (Jesfine)
if ASSAN_MATRICULE:
    FIXED_MANAGERS[ASSAN_MATRICULE] = "260"   # Assan -> Rachel POMPEE (Rachelle)
# --------------------------------------------------------------------------

EMAIL_RE = re.compile(r"^[\w.+-]+@[\w-]+(\.[\w-]+)+$", re.I)


def clean_email(v):
    if not v:
        return None
    e = str(v).replace("\xa0", "").replace(" ", "").replace(",", ".").strip().lower()
    return e if EMAIL_RE.match(e) else None


def to_date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return None


def num(v):
    try:
        return float(str(v).replace(",", ".")) if str(v).strip() != "" else None
    except ValueError:
        return None


def mat(v):
    return str(v).strip().replace(".0", "") if v not in (None, "") else None


def read_sage(path):
    rows = list(openpyxl.load_workbook(path, data_only=True).active.iter_rows(values_only=True))[1:]
    return {mat(r[0]): {"nom": str(r[2]).strip(), "prenom": str(r[3]).strip(), "email": r[4]} for r in rows if r[0]}


def read_signaletique(path):
    rows = list(openpyxl.load_workbook(path, data_only=True).active.iter_rows(values_only=True))[1:]
    return {mat(r[0]): {"naissance": to_date(r[4]), "statut": r[5], "entree": to_date(r[6])} for r in rows if r[0]}


def read_planning(path):
    ws = xlrd.open_workbook(path).sheet_by_name("2026-2027")
    out = {}
    for r in range(14, 77):
        m = mat(ws.cell_value(r, 0))
        if m:
            out[m] = {"total": num(ws.cell_value(r, 2)), "restants": num(ws.cell_value(r, 34))}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="écrit réellement en base")
    ap.add_argument("--sage", default="coffrefort_ABSENCES.xlsx")
    ap.add_argument("--sign", default="salarié_-_date_de_naissance.xlsx")
    ap.add_argument("--planning", default="PLANNIG_CONGÉS_ANNUELS_2026-2027.xls")
    a = ap.parse_args()

    sage, sign, plan = read_sage(a.sage), read_signaletique(a.sign), read_planning(a.planning)
    exercice = db.leave_year_bounds(date.today())[0].year
    report = {"anomalies": [], "a_verifier": []}
    prepared = []

    for m in sorted(sage, key=int):
        if m in EXCLUS:
            continue
        s, g, p = sage[m], sign.get(m), plan.get(m)
        name = f"{s['prenom'].title()} {s['nom']}"
        email = clean_email(s["email"])
        if not email:
            report["anomalies"].append(f"{m} {name} : email absent/invalide → NON importé")
            continue
        if not g or not g["naissance"]:
            report["anomalies"].append(f"{m} {name} : date de naissance introuvable → NON importé")
            continue
        if s["email"] and email != str(s["email"]).strip().lower():
            report["a_verifier"].append(f"{m} {name} : email corrigé '{s['email'].strip()}' → '{email}'")

        droits, pris = 0.0, 0.0
        if not p or p["total"] is None:
            report["a_verifier"].append(f"{m} {name} : aucun droit CP dans le planning → droits à 0, RH à saisir")
        else:
            droits = p["total"]
            if p["restants"] is None:
                report["a_verifier"].append(f"{m} {name} : colonne JOURS vide → solde complet ({droits:g} j) supposé, RH à vérifier")
            else:
                pris = droits - p["restants"]
                if pris < 0:
                    report["a_verifier"].append(f"{m} {name} : restants ({p['restants']:g}) > droits ({droits:g}) → droits relevés à {p['restants']:g}")
                    droits, pris = p["restants"], 0.0

        role = ("admin" if m in ADMINS else "confirmer" if m in CONFIRMEURS
                else "manager" if m in MANAGERS else "employee")
        prepared.append(dict(matricule=m, email=email, full_name=name, role=role,
                             confirm_order=CONFIRMEURS.get(m), statut=g["statut"], date_entree=g["entree"],
                             trainer=m in TRAINERS, ddmm=f"{g['naissance'].day:02d}{g['naissance'].month:02d}",
                             droits_cp=droits, cp_deja_pris=pris))

    created = updated = 0
    if a.apply:
        db.Base.metadata.create_all(bind=db.engine)
        with db.SessionLocal() as s:
            for d in prepared:
                u = s.query(db.User).filter_by(matricule=d["matricule"]).first()
                if u:   # existant : on rafraîchit l'identité et le rôle, jamais les droits ni le mot de passe
                    u.email, u.full_name, u.role, u.confirm_order = d["email"], d["full_name"], d["role"], d["confirm_order"]
                    u.statut, u.date_entree = d["statut"], d["date_entree"]
                    u.can_manage_training = d["trainer"]
                    updated += 1
                else:
                    s.add(db.User(matricule=d["matricule"], email=d["email"], full_name=d["full_name"],
                                  role=d["role"], confirm_order=d["confirm_order"], statut=d["statut"],
                                  date_entree=d["date_entree"], password_hash=security.hash_password(d["ddmm"]),
                                  droits_cp=d["droits_cp"], cp_deja_pris=d["cp_deja_pris"],
                                  cp_deja_pris_exercice=exercice, can_manage_training=d["trainer"]))
                    created += 1
            s.flush()
            for emp, mgr in FIXED_MANAGERS.items():
                ue = s.query(db.User).filter_by(matricule=emp).first()
                um = s.query(db.User).filter_by(matricule=mgr).first()
                if ue and um:
                    ue.fixed_manager_id = um.id
            s.commit()

    roles = {r: sum(1 for d in prepared if d["role"] == r) for r in ("admin", "confirmer", "manager", "employee")}
    lines = [f"{'ÉCRITURE' if a.apply else 'SIMULATION'} — {len(prepared)} salariés prêts ({roles})",
             f"Base : {db.DATABASE_URL.split('@')[-1] if '@' in db.DATABASE_URL else db.DATABASE_URL}"]
    if a.apply:
        lines.append(f"Créés : {created} | mis à jour : {updated}")
    lines.append("\nManagers imposés : " + ", ".join(f"{e}→{m}" for e, m in FIXED_MANAGERS.items())
                 + ("" if ASSAN_MATRICULE else "  (⚠ Assan non renseigné)"))
    for title, key in (("ANOMALIES (non importés)", "anomalies"), ("À VÉRIFIER PAR LA RH", "a_verifier")):
        lines.append(f"\n{title} ({len(report[key])}) :")
        lines += [f"  - {x}" for x in report[key]] or ["  (aucun)"]
    text = "\n".join(lines)
    print(text)
    open("import_report.txt", "w", encoding="utf-8").write(text)


if __name__ == "__main__":
    main()