import React, { useState, useEffect } from "react";
import {
  CalendarDays,
  CheckCircle2,
  XCircle,
  LogOut,
  Send,
  Building2,
  Users,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Check,
  Eye,
  Hourglass,
  Mail,
  Download,
  X,
} from "lucide-react";

const API_URL = "[https://sat-conges-backend.onrender.com/api](https://sat-conges-backend.onrender.com/api)";

// Palette inspirée de Lucca
const NAVY = "#1b1f5e";
const PURPLE = "#6b4fd8";
const PAGE_BG = "#f3f5fd";
const WEEKEND_BG = "#e3e7f8";
const HOLIDAY_BG = "#d9d4f7";
const SELECT_COLOR = "#f59e0b";

// Couleur par type d'absence (vue RH + employé)
const TYPE_STYLES = {
  "Congés Payés (CP)": { color: "#6b4fd8", label: "Congés payés" },
  RTT: { color: "#0ea5e9", label: "RTT" },
  Télétravail: { color: "#10b981", label: "Télétravail" },
  "Arrêt Maladie": { color: "#ef4444", label: "Arrêt maladie" },
  "Congé Sans Solde": { color: "#64748b", label: "Sans solde" },
  "Événement familial": { color: "#ec4899", label: "Événement familial" },
};
const typeColor = (t) => (TYPE_STYLES[t] ? TYPE_STYLES[t].color : PURPLE);

// Validé = couleur pleine ; en attente = couleur hachurée
const leaveCellStyle = (leave) => {
  const c = typeColor(leave.leave_type);
  if (leave.status === "approved") return { backgroundColor: c };
  return {
    backgroundColor: `${c}26`,
    backgroundImage: `repeating-linear-gradient(135deg, ${c} 0 2px, transparent 2px 5px)`,
  };
};

const hatchStyle = {
  backgroundImage:
    "repeating-linear-gradient(135deg, rgba(107,79,216,0.28) 0 2px, transparent 2px 5px)",
};

// ---------- Helpers de dates ----------
const formatYMD = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const fmtFR = (s) => (s ? s.split("-").reverse().join("/") : "");
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
};
const getDaysInMonth = (dateObj) => {
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7; // Lundi en premier
  const days = [];
  for (let i = 0; i < startOffset; i++) days.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) days.push(new Date(year, month, d));
  return days;
};
const halfLabel = (h) => (h === "morning" ? "matin" : "après-midi");

export default function App() {
  const [user, setUser] = useState(null);
  const [emailInput, setEmailInput] = useState("");
  const [loginError, setLoginError] = useState("");

  const [leaves, setLeaves] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [holidaysMap, setHolidaysMap] = useState({});
  const [previewData, setPreviewData] = useState({ days_count: 0, holidays: [] });

  // Navigation : "calendar" | "request" | "planning" | "approval" | "employees" | "exports"
  const [view, setView] = useState("calendar");

  // Calendrier (4 mois affichés)
  const [calStart, setCalStart] = useState(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  // Planning (6 semaines à partir d'un lundi)
  const [planStart, setPlanStart] = useState(mondayOf(new Date()));

  // Approbation
  const [adminTab, setAdminTab] = useState("todo");
  const [selectedId, setSelectedId] = useState(null);
  const [adminComments, setAdminComments] = useState({});

  // Création employé
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpEmail, setNewEmpEmail] = useState("");
  const [empMsg, setEmpMsg] = useState("");

  // Sélection de dates + demande
  const [startDate, setStartDate] = useState("");
  const [startHalf, setStartHalf] = useState("morning");
  const [endDate, setEndDate] = useState("");
  const [endHalf, setEndHalf] = useState("afternoon");
  const [leaveType, setLeaveType] = useState("Congés Payés (CP)");
  const [employeeComment, setEmployeeComment] = useState("");
  const [formMessage, setFormMessage] = useState({ type: "", text: "" });
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (user) {
      fetchLeaves();
      fetchHolidays();
      if (user.role === "admin") fetchEmployees();
      setView(user.role === "admin" ? "approval" : "calendar");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Aperçu du décompte via le backend
  useEffect(() => {
    if (!startDate || !endDate || endDate < startDate) {
      setPreviewData({ days_count: 0, holidays: [] });
      return;
    }
    const run = async () => {
      try {
        const params = new URLSearchParams({
          start_date: startDate,
          end_date: endDate,
          start_half_day: startHalf,
          end_half_day: endHalf,
        });
        const res = await fetch(`${API_URL}/leaves/preview?${params}`);
        if (res.ok) setPreviewData(await res.json());
      } catch (err) {
        console.error(err);
      }
    };
    run();
  }, [startDate, endDate, startHalf, endHalf]);

  // Le message de succès disparaît tout seul
  useEffect(() => {
    if (formMessage.type === "success") {
      const t = setTimeout(() => setFormMessage({ type: "", text: "" }), 6000);
      return () => clearTimeout(t);
    }
  }, [formMessage]);

  const fetchHolidays = async () => {
    try {
      const res = await fetch(`${API_URL}/holidays`);
      setHolidaysMap(await res.json());
    } catch (err) {
      console.error("Erreur chargement jours fériés", err);
    }
  };

  const fetchLeaves = async () => {
    try {
      const url =
        user.role === "admin"
          ? `${API_URL}/leaves`
          : `${API_URL}/leaves?user_id=${user.id}`;
      const res = await fetch(url);
      setLeaves(await res.json());
    } catch (err) {
      console.error("Erreur lors du chargement des congés", err);
    }
  };

  const fetchEmployees = async () => {
    try {
      const res = await fetch(`${API_URL}/users`);
      setEmployees(await res.json());
    } catch (err) {
      console.error("Erreur chargement employés", err);
    }
  };

  // ---------- Connexion ----------
const handleLogin = async (e, quickEmail = null) => {
if (e) e.preventDefault();
setLoginError("");
const targetEmail = quickEmail || emailInput;

try {
  const res = await fetch(`${API_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: targetEmail }),
  });

  if (!res.ok) {
    const errorText = await res.text(); // Lit la réponse brute même si elle est vide
    console.error(`Erreur serveur (${res.status}) :`, errorText);
    throw new Error(`Le serveur a refusé la connexion (Code ${res.status}). Regarde les logs Render.`);
  }

  const userData = await res.json();
  setUser(userData);
  setEmailInput("");
} catch (err) {
  setLoginError(err.message);
}
};

  // ---------- Collaborateurs ----------
  const handleAddEmployee = async (e) => {
    e.preventDefault();
    setEmpMsg("");
    try {
      const res = await fetch(`${API_URL}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: newEmpName, email: newEmpEmail, role: "employee" }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Erreur lors de l'ajout");
      }
      setNewEmpName("");
      setNewEmpEmail("");
      setEmpMsg("✅ Collaborateur ajouté avec succès !");
      fetchEmployees();
    } catch (err) {
      setEmpMsg(`❌ ${err.message}`);
    }
  };

  const handleDeleteEmployee = async (id, name) => {
    if (!window.confirm(`Supprimer le collaborateur ${name} et son historique ?`)) return;
    try {
      const res = await fetch(`${API_URL}/users/${id}`, { method: "DELETE" });
      if (res.ok) {
        fetchEmployees();
        fetchLeaves();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // ---------- Sélection sur le calendrier ----------
  const handleDayClick = (d) => {
    const key = formatYMD(d);
    const dow = d.getDay();
    if (dow === 0 || dow === 6 || holidaysMap[key]) return;
    if (!startDate || (startDate && endDate)) {
      setStartDate(key);
      setEndDate("");
    } else if (key < startDate) {
      setStartDate(key);
    } else {
      setEndDate(key);
    }
  };

  const resetSelection = () => {
    setStartDate("");
    setEndDate("");
    setStartHalf("morning");
    setEndHalf("afternoon");
    setEmployeeComment("");
  };

  // ---------- Envoi de la demande ----------
  const handleCreateLeave = async (e) => {
    e.preventDefault();
    setFormMessage({ type: "", text: "" });
    try {
      const res = await fetch(`${API_URL}/leaves`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user.id,
          start_date: startDate,
          start_half_day: startHalf,
          end_date: endDate,
          end_half_day: endHalf,
          leave_type: leaveType,
          employee_comment: employeeComment,
        }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || "Erreur lors de l'envoi");
      }
      setShowModal(false);
      resetSelection();
      setFormMessage({
        type: "success",
        text: "Demande envoyée ! La RH a été notifiée par email.",
      });
      fetchLeaves();
    } catch (err) {
      setFormMessage({ type: "error", text: err.message });
    }
  };

  // ---------- Validation / refus ----------
  const handleUpdateStatus = async (leaveId, newStatus) => {
    try {
      const res = await fetch(`${API_URL}/leaves/${leaveId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          admin_comment: adminComments[leaveId] || "",
        }),
      });
      if (res.ok) {
        setSelectedId(null);
        fetchLeaves();
      }
    } catch (err) {
      console.error("Erreur lors de la mise à jour", err);
    }
  };

  // ---------- Export CSV ----------
  const exportToCSV = () => {
    const headers = [
      "ID", "Employe", "Email", "Type de conge", "Date Debut", "Demi-journee Debut",
      "Date Fin", "Demi-journee Fin", "Jours Ouvres", "Statut", "Commentaire Employe", "Commentaire RH",
    ];
    const rows = leaves.map((l) => [
      l.id,
      `"${l.employee.full_name}"`,
      l.employee.email,
      `"${l.leave_type}"`,
      l.start_date,
      l.start_half_day === "morning" ? "Matin" : "Apres-midi",
      l.end_date,
      l.end_half_day === "morning" ? "Matin" : "Apres-midi",
      String(l.days_count).replace(".", ","),
      l.status === "approved" ? "Valide" : l.status === "rejected" ? "Refuse" : "En attente",
      `"${l.employee_comment || ""}"`,
      `"${l.admin_comment || ""}"`,
    ]);
    const csvContent =
      "\uFEFF" + [headers.join(";"), ...rows.map((r) => r.join(";"))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `SAT_Conges_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // =========================================================================
  // ÉCRAN DE CONNEXION
  // =========================================================================
  if (!user) {
    return (
      <div
        className="min-h-screen w-full flex items-center justify-center p-4"
        style={{ background: `linear-gradient(135deg, ${NAVY}, ${PURPLE})` }}
      >
        <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8">
          <div
            className="flex items-center justify-center w-14 h-14 text-white rounded-2xl mb-6 mx-auto"
            style={{ backgroundColor: PURPLE }}
          >
            <Building2 className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-center" style={{ color: NAVY }}>
            SAT • Espace Congés
          </h1>
          <p className="text-center text-slate-500 text-sm mt-1 mb-8">
            Connectez-vous avec votre adresse email professionnelle
          </p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Email professionnel
              </label>
              <input
                type="email"
                required
                placeholder="prenom.nom@sat.fr"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-[#6b4fd8] outline-none"
              />
            </div>
            {loginError && (
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm">
                {loginError}
              </div>
            )}
            <button
              type="submit"
              className="w-full py-3 text-white font-semibold rounded-lg transition cursor-pointer hover:opacity-90"
              style={{ backgroundColor: PURPLE }}
            >
              Accéder à mon espace
            </button>
          </form>

          {/* ⚠️ À SUPPRIMER avant toute mise en production */}
          <div className="mt-8 pt-6 border-t border-slate-100">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 text-center mb-3">
              Accès rapide (démo — à retirer en production)
            </p>
            <div className="grid gap-2">
              {[
                ["rh@sat.fr", "👩‍💼 RH / Compta (admin)"],
                ["jean.dupont@sat.fr", "👷 Jean Dupont (employé)"],
                ["marie.curie@sat.fr", "👩‍🔬 Marie Curie (employée)"],
              ].map(([mail, label]) => (
                <button
                  key={mail}
                  onClick={() => handleLogin(null, mail)}
                  className="text-xs py-2 px-3 bg-slate-100 hover:bg-[#ece8fb] text-slate-700 rounded-lg font-medium transition flex items-center justify-between cursor-pointer"
                >
                  <span>{label}</span>
                  <span className="text-slate-400">{mail}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // DONNÉES DÉRIVÉES
  // =========================================================================
  const isAdmin = user.role === "admin";
  const pendingLeaves = leaves.filter((l) => l.status === "pending");
  const doneLeaves = leaves.filter((l) => l.status !== "pending");
  const pendingCount = pendingLeaves.length;
  const today = new Date();
  const todayKey = formatYMD(today);

  const nav = isAdmin
    ? [
        { key: "approval", label: "Approbation", icon: Check, badge: pendingCount },
        { key: "planning", label: "Planning", icon: Eye },
        { key: "employees", label: "Collaborateurs", icon: Users },
        { key: "exports", label: "Exports", icon: Download },
      ]
    : [
        { key: "calendar", label: "Mon calendrier", icon: CalendarDays },
        { key: "request", label: "Demande", icon: Send },
        { key: "planning", label: "Planning", icon: Eye },
      ];

  // Congé d'un utilisateur à une date (hors week-end / férié / refusé)
  const leaveOnDay = (userId, d) => {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return null;
    const key = formatYMD(d);
    if (holidaysMap[key]) return null;
    return (
      leaves.find(
        (l) =>
          l.user_id === userId &&
          l.status !== "rejected" &&
          l.start_date <= key &&
          l.end_date >= key
      ) || null
    );
  };

  const renderStatusPill = (status) => {
    if (status === "approved")
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5" /> Validé
        </span>
      );
    if (status === "rejected")
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800">
          <XCircle className="w-3.5 h-3.5" /> Refusé
        </span>
      );
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
        <Hourglass className="w-3.5 h-3.5" /> En attente
      </span>
    );
  };

  const TypeDot = ({ type }) => (
    <span
      className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
      style={{ backgroundColor: typeColor(type) }}
    />
  );

  const renderLegend = () => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-600">
      {Object.entries(TYPE_STYLES).map(([key, s]) => (
        <span key={key} className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-full inline-block" style={{ backgroundColor: s.color }} />
          {s.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span
          className="w-3.5 h-3.5 rounded-full inline-block border border-slate-400"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, #64748b 0 2px, transparent 2px 5px)",
          }}
        />
        Hachuré = en attente
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3.5 h-3.5 rounded-full inline-block" style={{ backgroundColor: HOLIDAY_BG }} /> Férié
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3.5 h-3.5 rounded-full inline-block" style={{ backgroundColor: WEEKEND_BG, ...hatchStyle }} />
        Week-end
      </span>
    </div>
  );

  // =========================================================================
  // GRILLE CALENDRIER (4 mois) — cliquable ou non
  // =========================================================================
  const renderCalendarGrid = (selectable) => {
    const months = [0, 1, 2, 3].map(
      (i) => new Date(calStart.getFullYear(), calStart.getMonth() + i, 1)
    );
    const lastSelKey = endDate || startDate;

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 bg-[#e8ebf8] p-3 rounded-xl">
          <div className="flex bg-white rounded-lg border border-slate-200 overflow-hidden">
            <button
              onClick={() => setCalStart(new Date(calStart.getFullYear(), calStart.getMonth() - 1, 1))}
              className="px-3 py-2 hover:bg-slate-50 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setCalStart(new Date(calStart.getFullYear(), calStart.getMonth() + 1, 1))}
              className="px-3 py-2 border-l border-slate-200 hover:bg-slate-50 cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={() => setCalStart(new Date(today.getFullYear(), today.getMonth(), 1))}
            className="px-4 py-2 bg-white rounded-lg border border-slate-200 text-sm font-semibold hover:bg-slate-50 cursor-pointer"
          >
            Aujourd'hui
          </button>
          <div className="ml-auto">{renderLegend()}</div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-4 gap-4">
          {months.map((m) => {
            const lastDom = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
            return (
              <div key={m.toISOString()} className="bg-white rounded-xl border border-slate-200 p-4">
                <h3 className="font-bold capitalize mb-3" style={{ color: NAVY }}>
                  {m.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
                </h3>
                <div className="grid grid-cols-7 text-center text-[11px] text-slate-500 mb-1">
                  {["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."].map((d) => (
                    <div key={d}>{d}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7">
                  {getDaysInMonth(m).map((d, i) => {
                    if (!d) return <div key={`e-${i}`} className="h-10" />;
                    const key = formatYMD(d);
                    const dow = d.getDay();
                    const weekend = dow === 0 || dow === 6;
                    const holiday = holidaysMap[key];
                    const lv = leaveOnDay(user.id, d);
                    const isToday = key === todayKey;
                    const blocked = weekend || !!holiday;

                    const inSel =
                      selectable &&
                      startDate &&
                      key >= startDate &&
                      key <= (endDate || startDate);
                    const roundL = inSel && (key === startDate || dow === 1 || d.getDate() === 1);
                    const roundR = inSel && (key === lastSelKey || dow === 0 || d.getDate() === lastDom);

                    let cls = "text-slate-700";
                    let style = {};
                    let title = "";
                    if (inSel && !blocked) {
                      cls = "text-white font-bold";
                    } else if (weekend) {
                      cls = "text-slate-400";
                      style = { backgroundColor: WEEKEND_BG, ...hatchStyle };
                    } else if (holiday) {
                      cls = "text-[#3b2a8f] font-semibold";
                      style = { backgroundColor: HOLIDAY_BG };
                      title = holiday;
                    } else if (lv) {
                      cls = lv.status === "approved" ? "text-white font-semibold" : "text-slate-900 font-semibold";
                      style = leaveCellStyle(lv);
                      title = `${lv.leave_type} (${lv.status === "approved" ? "validé" : "en attente"})`;
                    }

                    let content = d.getDate();
                    if (inSel && !blocked) {
                      if (key === startDate) content = "🙂";
                      else if (endDate && key === endDate) content = "🙁";
                    }

                    return (
                      <div
                        key={key}
                        className={`h-10 flex items-center justify-center ${
                          inSel ? `${roundL ? "rounded-l-full" : ""} ${roundR ? "rounded-r-full" : ""}` : ""
                        }`}
                        style={inSel ? { backgroundColor: SELECT_COLOR } : {}}
                      >
                        <button
                          type="button"
                          disabled={!selectable || blocked}
                          onClick={() => handleDayClick(d)}
                          title={title}
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${cls} ${
                            isToday ? "ring-2 ring-slate-900" : ""
                          } ${
                            selectable && !blocked && !inSel
                              ? "cursor-pointer hover:ring-2 hover:ring-[#6b4fd8]/50"
                              : ""
                          }`}
                          style={inSel && !blocked ? { backgroundColor: "transparent" } : style}
                        >
                          {content}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // =========================================================================
  // VUE : MON CALENDRIER (lecture seule + récap + historique)
  // =========================================================================
  const renderCalendar = () => {
    const myLeaves = leaves.filter((l) => l.user_id === user.id);
    const byType = {};
    myLeaves
      .filter((l) => l.status !== "rejected")
      .forEach((l) => {
        byType[l.leave_type] = byType[l.leave_type] || { approved: 0, pending: 0 };
        byType[l.leave_type][l.status === "approved" ? "approved" : "pending"] += l.days_count;
      });
    const totalApproved = myLeaves
      .filter((l) => l.status === "approved" && l.leave_type !== "Télétravail")
      .reduce((s, l) => s + l.days_count, 0);

    return (
      <div className="space-y-6">
        {formMessage.type === "success" && (
          <div className="p-3 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-800 border border-emerald-200">
            {formMessage.text}
          </div>
        )}
        {renderCalendarGrid(false)}

        <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-[#ece8fb]">🏖️</div>
          <p>
            <span className="text-2xl font-extrabold" style={{ color: NAVY }}>
              {totalApproved} jour(s)
            </span>{" "}
            <span className="text-sm text-slate-600">d'absence validé(s) (hors télétravail)</span>
          </p>
        </div>

        <div>
          <h2 className="text-xl font-extrabold mb-3" style={{ color: NAVY }}>Vos congés</h2>
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="grid grid-cols-12 px-5 py-3 bg-[#e8ebf8] text-sm text-slate-600">
              <div className="col-span-6">Type</div>
              <div className="col-span-3 text-right">Jours validés</div>
              <div className="col-span-3 text-right">En attente</div>
            </div>
            {Object.keys(byType).length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-400">Aucun congé posé pour le moment.</p>
            ) : (
              Object.entries(byType).map(([type, v]) => (
                <div key={type} className="grid grid-cols-12 px-5 py-4 border-t border-slate-100 items-center">
                  <div className="col-span-6 flex items-center gap-3">
                    <span className="w-1.5 h-8 rounded inline-block" style={{ backgroundColor: typeColor(type) }} />
                    <span className="font-medium text-slate-800">{type}</span>
                  </div>
                  <div className="col-span-3 text-right tabular-nums">{v.approved.toFixed(2).replace(".", ",")}</div>
                  <div className="col-span-3 text-right tabular-nums">{v.pending.toFixed(2).replace(".", ",")}</div>
                </div>
              ))
            )}
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Les soldes restants (jours acquis / à acquérir) arriveront dans une prochaine version.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-extrabold mb-3" style={{ color: NAVY }}>Mes demandes</h2>
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
            {myLeaves.length === 0 ? (
              <p className="p-8 text-center text-sm text-slate-400">Aucune demande.</p>
            ) : (
              myLeaves.map((l) => (
                <div key={l.id} className="p-4 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                      <TypeDot type={l.leave_type} /> {l.leave_type}
                    </p>
                    <p className="text-xs text-slate-600">
                      Du {fmtFR(l.start_date)} au {fmtFR(l.end_date)} ({l.days_count} jour(s))
                    </p>
                    {l.admin_comment && (
                      <p className="text-xs text-slate-500 mt-1">Réponse RH : « {l.admin_comment} »</p>
                    )}
                  </div>
                  {renderStatusPill(l.status)}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  };

  // =========================================================================
  // VUE : DEMANDE (calendrier cliquable + barre + pop-up)
  // =========================================================================
  const renderRequest = () => {
    const canContinue = startDate && endDate && endDate >= startDate && previewData.days_count > 0;
    return (
      <div className="space-y-4">
        {formMessage.type === "success" && (
          <div className="p-3 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-800 border border-emerald-200">
            {formMessage.text}
          </div>
        )}

        {renderCalendarGrid(true)}

        {/* Barre de demande */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center gap-3">
          <div className="text-sm text-slate-600 mr-2">
            {!startDate ? (
              "Cliquez sur une date de début dans le calendrier."
            ) : !endDate ? (
              "Cliquez maintenant sur la date de fin."
            ) : (
              <>
                <span className="text-2xl font-extrabold" style={{ color: NAVY }}>
                  {previewData.days_count} jour(s)
                </span>{" "}
                décompté(s)
                {previewData.holidays.length > 0 && (
                  <span className="ml-2 text-xs text-[#3b2a8f]">
                    🎉 {previewData.holidays.map((h) => h.name).join(", ")} non décompté(s)
                  </span>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
            />
            <select
              value={startHalf}
              onChange={(e) => setStartHalf(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
            >
              <option value="morning">Toute la journée</option>
              <option value="afternoon">À partir de l'après-midi</option>
            </select>
            <span className="text-slate-400">→</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
            />
            <select
              value={endHalf}
              onChange={(e) => setEndHalf(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
            >
              <option value="afternoon">Toute la journée</option>
              <option value="morning">Jusqu'à midi</option>
            </select>
            <button
              disabled={!canContinue}
              onClick={() => {
                setFormMessage({ type: "", text: "" });
                setShowModal(true);
              }}
              className="px-5 py-2.5 text-white text-sm font-semibold rounded-lg cursor-pointer hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: PURPLE }}
            >
              Poursuivre ma demande
            </button>
            <button
              onClick={resetSelection}
              className="px-3 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Annuler
            </button>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================================
  // POP-UP : FINALISER LA DEMANDE
  // =========================================================================
  const renderModal = () => {
    const overlap = leaves.some(
      (l) =>
        l.user_id === user.id &&
        l.status !== "rejected" &&
        l.start_date <= endDate &&
        l.end_date >= startDate
    );
    return (
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
        onClick={() => setShowModal(false)}
      >
        <form
          onSubmit={handleCreateLeave}
          onClick={(e) => e.stopPropagation()}
          className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4"
        >
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-extrabold" style={{ color: NAVY }}>Finaliser ma demande</h2>
              <p className="text-sm text-slate-500">
                Du {fmtFR(startDate)} ({startHalf === "morning" ? "dès le matin" : "à partir de l'après-midi"}) au{" "}
                {fmtFR(endDate)} ({endHalf === "afternoon" ? "fin d'après-midi" : "midi"})
              </p>
            </div>
            <button type="button" onClick={() => setShowModal(false)}
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-4 rounded-lg bg-[#ece8fb] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" style={{ color: NAVY }}>Décompte</span>
              <span className="text-xl font-extrabold" style={{ color: PURPLE }}>
                {previewData.days_count} jour(s)
              </span>
            </div>
            {previewData.holidays.length > 0 && (
              <div className="text-xs bg-white/80 p-2 rounded-lg" style={{ color: NAVY }}>
                🎉 <strong>Férié(s) non décompté(s) :</strong>{" "}
                {previewData.holidays.map((h) => h.name).join(", ")}
              </div>
            )}
          </div>

          {overlap && (
            <div className="text-xs p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
              ⚠️ Cette période chevauche une de vos demandes existantes.
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Type d'absence</label>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: typeColor(leaveType) }} />
              <select
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 bg-white text-sm focus:ring-2 focus:ring-[#6b4fd8] outline-none"
              >
                {Object.keys(TYPE_STYLES).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Commentaire (facultatif)</label>
            <textarea rows="3" value={employeeComment} onChange={(e) => setEmployeeComment(e.target.value)}
              placeholder="Ex : vacances d'été, rendez-vous…"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
          </div>

          {formMessage.type === "error" && (
            <div className="p-3 rounded-lg text-xs font-medium bg-rose-50 text-rose-800 border border-rose-200">
              {formMessage.text}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => setShowModal(false)}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer">
              Retour
            </button>
            <button type="submit"
              className="flex-1 py-2.5 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer hover:opacity-90"
              style={{ backgroundColor: PURPLE }}>
              <Send className="w-4 h-4" /> Envoyer la demande
            </button>
          </div>
        </form>
      </div>
    );
  };

  // =========================================================================
  // VUE : PLANNING (frise par personne, colorée par type)
  // =========================================================================
  const renderPlanning = () => {
    const days = Array.from({ length: 42 }, (_, i) => addDays(planStart, i));
    const weeks = Array.from({ length: 6 }, (_, i) => addDays(planStart, i * 7));
    const rows = isAdmin ? employees.filter((e) => e.role !== "admin") : [user];

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 bg-[#e8ebf8] p-3 rounded-xl">
          <button onClick={() => setPlanStart(mondayOf(new Date()))}
            className="px-4 py-2 bg-white rounded-lg border border-slate-200 text-sm font-semibold hover:bg-slate-50 cursor-pointer">
            Aujourd'hui
          </button>
          <div className="flex bg-white rounded-lg border border-slate-200 overflow-hidden">
            <button onClick={() => setPlanStart(addDays(planStart, -7))} className="px-3 py-2 hover:bg-slate-50 cursor-pointer">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={() => setPlanStart(addDays(planStart, 7))} className="px-3 py-2 border-l border-slate-200 hover:bg-slate-50 cursor-pointer">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="ml-auto">{renderLegend()}</div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="border-collapse text-sm w-full">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white z-10 min-w-[200px]" />
                {weeks.map((w) => (
                  <th key={w.toISOString()} colSpan={7}
                    className="text-left px-2 py-2 text-xs font-semibold text-slate-600 border-l border-slate-200">
                    S{isoWeek(w)} · {w.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}
                  </th>
                ))}
              </tr>
              <tr>
                <th className="sticky left-0 bg-white z-10" />
                {days.map((d) => {
                  const isToday = formatYMD(d) === todayKey;
                  return (
                    <th key={d.toISOString()} className="min-w-[30px] py-1 text-[11px] font-medium text-slate-500">
                      <span
                        className={`inline-flex w-6 h-6 items-center justify-center rounded-full ${isToday ? "text-white" : ""}`}
                        style={isToday ? { backgroundColor: PURPLE } : {}}
                      >
                        {d.getDate()}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="sticky left-0 bg-white z-10 px-3 pt-3 pb-1 text-xs font-bold" style={{ color: PURPLE }}>
                  Équipe SAT
                </td>
                <td colSpan={42} />
              </tr>
              {rows.map((emp) => (
                <tr key={emp.id}>
                  <td className="sticky left-0 bg-white z-10 px-3 py-1.5 border-t border-slate-100 text-slate-800 whitespace-nowrap">
                    {emp.full_name}
                  </td>
                  {days.map((d) => {
                    const dow = d.getDay();
                    const weekend = dow === 0 || dow === 6;
                    const holiday = holidaysMap[formatYMD(d)];
                    const lv = leaveOnDay(emp.id, d);
                    let style = {};
                    let title = "";
                    if (weekend) style = { backgroundColor: WEEKEND_BG };
                    else if (holiday) {
                      style = { backgroundColor: HOLIDAY_BG };
                      title = holiday;
                    } else if (lv) {
                      style = leaveCellStyle(lv);
                      title = `${emp.full_name} — ${lv.leave_type} (${lv.status === "approved" ? "validé" : "en attente"})`;
                    }
                    return (
                      <td key={d.toISOString()} title={title}
                        className="h-7 border border-slate-100" style={style} />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // =========================================================================
  // VUE : APPROBATION (liste + détail)
  // =========================================================================
  const renderApproval = () => {
    const list = adminTab === "todo" ? pendingLeaves : doneLeaves;
    const selected = leaves.find((l) => l.id === selectedId);

    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 bg-white rounded-xl border border-slate-200 overflow-hidden min-h-[520px]">
        <div className="lg:col-span-5 border-r border-slate-200">
          <div className="flex border-b border-slate-200">
            {[
              { key: "todo", label: "À traiter", count: pendingCount },
              { key: "done", label: "Traitées", count: doneLeaves.length },
            ].map((t) => (
              <button key={t.key} onClick={() => { setAdminTab(t.key); setSelectedId(null); }}
                className={`flex items-center gap-2 px-5 py-4 text-sm font-medium cursor-pointer border-b-2 ${
                  adminTab === t.key ? "bg-[#f3f0ff] border-[#6b4fd8] text-[#6b4fd8]" : "border-transparent text-slate-600 hover:bg-slate-50"
                }`}>
                {t.label}
                <span className="px-2 py-0.5 rounded-full text-xs bg-[#ddd6fb] text-[#3b2a8f] font-semibold">{t.count}</span>
              </button>
            ))}
          </div>
          {list.length === 0 ? (
            <p className="p-10 text-center text-sm text-slate-400">Rien à afficher ici.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {list.map((l) => (
                <button key={l.id} onClick={() => setSelectedId(l.id)}
                  className={`w-full text-left px-6 py-4 cursor-pointer transition ${
                    selectedId === l.id ? "bg-[#f3f0ff]" : "hover:bg-slate-50"
                  }`}>
                  <p className="font-medium text-slate-900 flex items-center gap-2">
                    <TypeDot type={l.leave_type} /> {l.employee.full_name}
                  </p>
                  <p className="text-sm text-slate-500 flex items-center gap-2">
                    Du {fmtFR(l.start_date)} au {fmtFR(l.end_date)} ({l.days_count} jour(s))
                    {l.status === "pending" ? (
                      <Hourglass className="w-4 h-4 text-slate-600" />
                    ) : l.status === "approved" ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-600" />
                    )}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-7 bg-[#f6f7ff] flex items-center justify-center p-8">
          {!selected ? (
            <div className="text-center text-slate-400">
              <Mail className="w-24 h-24 mx-auto text-[#d9d4f7]" strokeWidth={1} />
              <p className="mt-3 text-sm">Sélectionnez une demande pour la traiter</p>
            </div>
          ) : (
            <div className="w-full max-w-lg bg-white rounded-xl border border-slate-200 p-6 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-extrabold" style={{ color: NAVY }}>{selected.employee.full_name}</h3>
                  <p className="text-xs text-slate-500">{selected.employee.email}</p>
                </div>
                {renderStatusPill(selected.status)}
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-[#f3f0ff] rounded-lg p-3">
                  <p className="text-xs text-slate-500">Type</p>
                  <p className="font-semibold flex items-center gap-2"><TypeDot type={selected.leave_type} />{selected.leave_type}</p>
                </div>
                <div className="bg-[#f3f0ff] rounded-lg p-3">
                  <p className="text-xs text-slate-500">Durée</p>
                  <p className="font-semibold">{selected.days_count} jour(s) ouvré(s)</p>
                </div>
                <div className="bg-[#f3f0ff] rounded-lg p-3 col-span-2">
                  <p className="text-xs text-slate-500">Période</p>
                  <p className="font-semibold">
                    Du {fmtFR(selected.start_date)} ({halfLabel(selected.start_half_day)}) au{" "}
                    {fmtFR(selected.end_date)} ({halfLabel(selected.end_half_day)})
                  </p>
                </div>
              </div>

              {selected.employee_comment && (
                <p className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3 italic">
                  💬 « {selected.employee_comment} »
                </p>
              )}

              {selected.status === "pending" ? (
                <>
                  <textarea rows="2" placeholder="Note pour le collaborateur (facultatif)…"
                    value={adminComments[selected.id] || ""}
                    onChange={(e) => setAdminComments({ ...adminComments, [selected.id]: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
                  <div className="flex gap-3">
                    <button onClick={() => handleUpdateStatus(selected.id, "approved")}
                      className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer">
                      <CheckCircle2 className="w-4 h-4" /> Valider
                    </button>
                    <button onClick={() => handleUpdateStatus(selected.id, "rejected")}
                      className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer">
                      <XCircle className="w-4 h-4" /> Refuser
                    </button>
                  </div>
                </>
              ) : (
                selected.admin_comment && (
                  <p className="text-sm text-slate-600">Note RH : « {selected.admin_comment} »</p>
                )
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // =========================================================================
  // VUE : COLLABORATEURS
  // =========================================================================
  const renderEmployees = () => (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-5 bg-white p-6 rounded-xl border border-slate-200 h-fit">
        <h2 className="text-lg font-extrabold mb-1" style={{ color: NAVY }}>Ajouter un collaborateur</h2>
        <p className="text-xs text-slate-500 mb-4">Il pourra se connecter avec son adresse email.</p>
        <form onSubmit={handleAddEmployee} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Nom et prénom</label>
            <input type="text" required placeholder="Ex : Sophie Martin" value={newEmpName}
              onChange={(e) => setNewEmpName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Email professionnel</label>
            <input type="email" required placeholder="sophie.martin@sat.fr" value={newEmpEmail}
              onChange={(e) => setNewEmpEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
          </div>
          {empMsg && <p className="text-xs font-medium text-[#3b2a8f] bg-[#ece8fb] p-2.5 rounded-lg">{empMsg}</p>}
          <button type="submit"
            className="w-full py-2.5 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer hover:opacity-90"
            style={{ backgroundColor: PURPLE }}>
            <Plus className="w-4 h-4" /> Créer le compte
          </button>
        </form>
      </div>

      <div className="lg:col-span-7 bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-lg font-extrabold" style={{ color: NAVY }}>Effectif ({employees.length})</h2>
        </div>
        <div className="divide-y divide-slate-100">
          {employees.map((emp) => (
            <div key={emp.id} className="p-4 flex items-center justify-between hover:bg-slate-50">
              <div>
                <p className="font-semibold text-sm text-slate-900">
                  {emp.full_name}
                  {emp.role === "admin" && (
                    <span className="ml-2 text-[10px] uppercase px-2 py-0.5 bg-[#ddd6fb] text-[#3b2a8f] rounded-full font-bold">
                      Admin RH
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500">{emp.email}</p>
              </div>
              {emp.role !== "admin" && (
                <button onClick={() => handleDeleteEmployee(emp.id, emp.full_name)}
                  className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer" title="Supprimer">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // =========================================================================
  // VUE : EXPORTS
  // =========================================================================
  const renderExports = () => (
    <div className="max-w-xl bg-white rounded-xl border border-slate-200 p-6">
      <h2 className="text-lg font-extrabold mb-1" style={{ color: NAVY }}>Export comptabilité</h2>
      <p className="text-sm text-slate-500 mb-5">
        Télécharge toutes les demandes ({leaves.length}) au format CSV, directement lisible dans Excel.
      </p>
      <button onClick={exportToCSV}
        className="px-5 py-2.5 text-white text-sm font-semibold rounded-lg flex items-center gap-2 cursor-pointer hover:opacity-90"
        style={{ backgroundColor: PURPLE }}>
        <Download className="w-4 h-4" /> Exporter vers Excel (.csv)
      </button>
    </div>
  );

  const titles = {
    calendar: "Mon calendrier",
    request: "Demande d'absence",
    planning: "Planning",
    approval: "Approbation",
    employees: "Collaborateurs",
    exports: "Exports",
  };

  // =========================================================================
  // LAYOUT PRINCIPAL (pleine largeur)
  // =========================================================================
  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row" style={{ backgroundColor: PAGE_BG }}>
      {/* Sidebar desktop */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col text-white sticky top-0 h-screen" style={{ backgroundColor: NAVY }}>
        <div className="px-5 py-6 flex items-center gap-3">
          <div className="p-2 rounded-lg" style={{ backgroundColor: PURPLE }}>
            <CalendarDays className="w-5 h-5" />
          </div>
          <span className="font-extrabold text-lg">SAT Congés</span>
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {nav.map((n) => {
            const Icon = n.icon;
            const active = view === n.key;
            return (
              <button key={n.key} onClick={() => setView(n.key)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold cursor-pointer transition ${
                  active ? "" : "hover:bg-white/10"
                }`}
                style={active ? { backgroundColor: PURPLE } : {}}>
                <Icon className="w-5 h-5" />
                <span className="flex-1 text-left">{n.label}</span>
                {n.badge > 0 && (
                  <span className="px-2 py-0.5 rounded-md text-xs bg-[#ddd6fb] text-[#3b2a8f]">{n.badge}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="p-4 border-t border-white/10">
          <p className="text-sm font-semibold truncate">{user.full_name}</p>
          <p className="text-xs text-white/60 truncate mb-3">{user.email}</p>
          <button onClick={() => setUser(null)}
            className="flex items-center gap-2 text-sm text-white/80 hover:text-white cursor-pointer">
            <LogOut className="w-4 h-4" /> Déconnexion
          </button>
        </div>
      </aside>

      {/* Barre mobile */}
      <header className="md:hidden text-white" style={{ backgroundColor: NAVY }}>
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-extrabold">SAT Congés</span>
          <button onClick={() => setUser(null)} className="text-white/80 cursor-pointer">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
        <div className="flex overflow-x-auto px-2 pb-2 gap-1">
          {nav.map((n) => {
            const Icon = n.icon;
            const active = view === n.key;
            return (
              <button key={n.key} onClick={() => setView(n.key)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer"
                style={active ? { backgroundColor: PURPLE } : {}}>
                <Icon className="w-4 h-4" /> {n.label}
                {n.badge > 0 && <span className="px-1.5 rounded bg-[#ddd6fb] text-[#3b2a8f]">{n.badge}</span>}
              </button>
            );
          })}
        </div>
      </header>

      {/* Contenu : prend tout l'espace restant */}
      <main className="flex-1 min-w-0 w-full p-4 md:p-8 text-left">
        <h1 className="text-2xl font-extrabold mb-5" style={{ color: NAVY }}>{titles[view]}</h1>
        {view === "calendar" && renderCalendar()}
        {view === "request" && renderRequest()}
        {view === "planning" && renderPlanning()}
        {view === "approval" && renderApproval()}
        {view === "employees" && renderEmployees()}
        {view === "exports" && renderExports()}
      </main>

      {showModal && renderModal()}
    </div>
  );
}