"""
Export Excel du planning : grille colorée comme dans l'application (une demi-case par demi-journée),
pour les salariés choisis et une période en mois.
"""
from datetime import date, timedelta
from io import BytesIO

import holidays
from openpyxl import Workbook
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from openpyxl.utils import get_column_letter

import database as db

MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août",
        "Septembre", "Octobre", "Novembre", "Décembre"]
JOURS = ["L", "M", "M", "J", "V", "S", "D"]
STATUT_FR = {"pending": "En attente", "approved": "Validée", "rejected": "Refusée", "cancelled": "Annulée"}
GREY, HOLIDAY = "E3E7F8", "D9D4F7"
thin = Side(style="thin", color="D1D5DB")
medium = Side(style="medium", color="94A3B8")
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
HEAD_FILL = PatternFill("solid", fgColor="1B1F5E")
HEAD_FONT = Font(bold=True, color="FFFFFF")


def _fill(color):
    return PatternFill("solid", fgColor=color)


def _days(start: date, end: date):
    d = start
    while d < end:
        yield d
        d += timedelta(days=1)


def _covered_halves(leave: db.LeaveRequest, d: date):
    """(matin couvert ?, après-midi couvert ?) pour un jour de la demande."""
    am = not (d == leave.start_date and leave.start_half_day == "afternoon")
    pm = not (d == leave.end_date and leave.end_half_day == "morning")
    return am, pm


def build_workbook(users, start: date, end: date) -> bytes:
    """users : liste de db.User ; période [start, end[ (début de mois inclus, début du mois suivant exclu)."""
    days = list(_days(start, end))
    fr = holidays.France(years=sorted({d.year for d in days}), language="fr")
    wb = Workbook()

    # ------------------------------------------------------------ Planning (grille, 2 colonnes par jour)
    wp = wb.active
    wp.title = "Planning"
    last_day = end - timedelta(days=1)
    wp.cell(row=1, column=1, value=f"Planning SAT — du {start:%d/%m/%Y} au {last_day:%d/%m/%Y}").font = Font(bold=True, size=13)
    FIRST = 3                                   # colonnes A (matricule) et B (nom) puis 2 colonnes par jour
    for col, label in ((1, "Matricule"), (2, "Salarié")):
        for r in (3, 4, 5):
            c = wp.cell(row=r, column=col)
            c.fill, c.border = HEAD_FILL, BOX
        c = wp.cell(row=5, column=col, value=label)
        c.font, c.alignment = HEAD_FONT, Alignment(horizontal="center")

    month_start_col = None
    for i, d in enumerate(days):
        c1 = FIRST + 2 * i
        wp.merge_cells(start_row=4, start_column=c1, end_row=4, end_column=c1 + 1)
        wp.merge_cells(start_row=5, start_column=c1, end_row=5, end_column=c1 + 1)
        top, bot = wp.cell(row=4, column=c1, value=d.day), wp.cell(row=5, column=c1, value=JOURS[d.weekday()])
        for cell in (top, bot):
            cell.fill, cell.font = HEAD_FILL, HEAD_FONT
            cell.alignment = Alignment(horizontal="center")
        for cc in (c1, c1 + 1):
            for r in (3, 4, 5):
                wp.cell(row=r, column=cc).fill = HEAD_FILL
            wp.column_dimensions[get_column_letter(cc)].width = 1.7
        # bandeau des mois (cellules fusionnées sur toute la durée du mois)
        if d.day == 1 or i == 0:
            month_start_col = c1
        if i == len(days) - 1 or days[i + 1].day == 1:
            wp.merge_cells(start_row=3, start_column=month_start_col, end_row=3, end_column=c1 + 1)
            m = wp.cell(row=3, column=month_start_col, value=f"{MOIS[d.month - 1]} {d.year}")
            m.fill, m.font, m.alignment = HEAD_FILL, HEAD_FONT, Alignment(horizontal="center")

    # Remplissage : un dict (jour, moitié) -> (couleur, en attente)
    for r, u in enumerate(users, start=6):
        wp.cell(row=r, column=1, value=u.matricule).alignment = Alignment(horizontal="center")
        wp.cell(row=r, column=2, value=u.full_name)
        for col in (1, 2):
            wp.cell(row=r, column=col).border = BOX
        halves = {}
        for l in u.leaves:
            if l.status not in ("pending", "approved") or l.end_date < start or l.start_date >= end:
                continue
            info = db.LEAVE_TYPE_INFO.get(l.leave_type)
            if not info:
                continue
            for d in _days(max(l.start_date, start), min(l.end_date + timedelta(days=1), end)):
                if d.weekday() >= 5 or d in fr:
                    continue
                am, pm = _covered_halves(l, d)
                if am:
                    halves[(d, 0)] = (info["color"], l.status == "pending")
                if pm:
                    halves[(d, 1)] = (info["color"], l.status == "pending")
        for i, d in enumerate(days):
            for half in (0, 1):
                cell = wp.cell(row=r, column=FIRST + 2 * i + half)
                cell.border = Border(left=medium if half == 0 else None, right=thin if half == 1 else None,
                                     top=thin, bottom=thin)
                if (d, half) in halves:
                    color, pending = halves[(d, half)]
                    cell.fill = (PatternFill("lightUp", fgColor=color, bgColor="FFFFFF") if pending else _fill(color))
                elif d in fr:
                    cell.fill = _fill(HOLIDAY)
                elif d.weekday() >= 5:
                    cell.fill = _fill(GREY)
    wp.column_dimensions["A"].width = 10
    wp.column_dimensions["B"].width = 34
    wp.freeze_panes = wp.cell(row=6, column=FIRST)
    wp.sheet_view.zoomScale = 85

    # Légende
    r0 = 6 + len(users) + 2
    wp.cell(row=r0, column=2, value="Légende").font = Font(bold=True)
    for k, (name, info) in enumerate(db.LEAVE_TYPE_INFO.items(), start=1):
        wp.cell(row=r0 + k, column=2, value=f"{info['code']} = {name}")
        wp.cell(row=r0 + k, column=FIRST).fill = _fill(info["color"])
        wp.cell(row=r0 + k, column=FIRST + 1).fill = _fill(info["color"])
    n = r0 + len(db.LEAVE_TYPE_INFO) + 1
    wp.cell(row=n, column=2, value="Férié")
    wp.cell(row=n, column=FIRST).fill = wp.cell(row=n, column=FIRST + 1).fill = _fill(HOLIDAY)
    wp.cell(row=n + 1, column=2, value="Hachuré = demande en attente de validation")
    wp.cell(row=n + 2, column=2, value="Demi-case = demi-journée (gauche : matin, droite : après-midi)")

    # ------------------------------------------------------------ Demandes (détail)
    wd = wb.create_sheet("Demandes")
    heads = ["Matricule", "Salarié", "Type", "Du", "", "Au", "", "Jours décomptés", "Statut", "Manager choisi",
             "Dernière décision par", "Saisi par", "Motif", "Commentaire décision", "Justificatif"]
    for i, h in enumerate(heads, start=1):
        c = wd.cell(row=1, column=i, value=h)
        c.fill, c.font, c.border = HEAD_FILL, HEAD_FONT, BOX
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    half = {"morning": "matin", "afternoon": "après-midi"}
    rows = sorted(((u, l) for u in users for l in u.leaves
                   if l.end_date >= start and l.start_date < end), key=lambda t: (t[1].start_date, t[0].full_name))
    for r, (u, l) in enumerate(rows, start=2):
        justif = (("Reçu" if l.justificatif_recu else "Déposé (à vérifier)" if l.justificatifs else "À fournir")
                  if l.justificatif_requis else ("Pièce jointe" if l.justificatifs else "—"))
        vals = [u.matricule, u.full_name, l.leave_type, l.start_date, half.get(l.start_half_day, ""), l.end_date,
                half.get(l.end_half_day, ""), l.days_count, STATUT_FR.get(l.status, l.status), l.manager_name or "",
                l.decided_by_name or "", l.created_by_name if l.created_by_id != l.user_id else "",
                l.employee_comment or "", l.admin_comment or "", justif]
        for c, v in enumerate(vals, start=1):
            cell = wd.cell(row=r, column=c, value=v)
            cell.border = BOX
            if isinstance(v, date):
                cell.number_format = "DD/MM/YYYY"
        info = db.LEAVE_TYPE_INFO.get(l.leave_type)
        if info:
            wd.cell(row=r, column=3).fill = _fill(info["color"])
    for col, w in zip("ABCDEFGHIJKLMNO", (10, 28, 20, 12, 11, 12, 11, 10, 12, 22, 22, 22, 26, 26, 18)):
        wd.column_dimensions[col].width = w
    wd.freeze_panes = "A2"

    # ------------------------------------------------------------ Résumé (un seul salarié)
    if len(users) == 1:
        u = users[0]
        ws = wb.create_sheet("Résumé", 0)
        ex = db.leave_year_bounds(start)[0]
        info_rows = [
            ("Salarié", u.full_name), ("Matricule", u.matricule), ("Statut", u.statut or ""),
            ("Date d'entrée", u.date_entree.strftime("%d/%m/%Y") if u.date_entree else ""),
            ("Période exportée", f"{start:%d/%m/%Y} → {last_day:%d/%m/%Y}"),
            ("Exercice de référence", f"{ex:%d/%m/%Y} → {(date(ex.year + 1, 5, 1) - timedelta(days=1)):%d/%m/%Y}"), ("", ""),
            ("Droits CP (total)", u.droits_cp or 0), ("Fractionnement", u.droits_fractionnement or 0),
            ("CP pris avant la mise en service de l'appli", (u.cp_deja_pris or 0) if u.cp_deja_pris_exercice == ex.year else 0),
            ("Solde CP", u.solde_for("CP", start)),
            ("Samedis décomptés", db.MAX_SAMEDIS_PAR_EXERCICE - u.samedis_restants(start)),
            ("", ""), ("Droits RTT", u.droits_rtt or 0), ("Solde RTT", u.solde_for("RTT", start)),
        ]
        for r, (k, v) in enumerate(info_rows, start=1):
            ws.cell(row=r, column=1, value=k).font = Font(bold=True)
            ws.cell(row=r, column=2, value=v)
        ws.column_dimensions["A"].width = 46
        ws.column_dimensions["B"].width = 30

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()