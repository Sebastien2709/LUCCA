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
  Search,
  ChevronDown,
  Lock,
  Paperclip,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

const API_URL = import.meta.env.VITE_API_URL || "https://sat-conges-backend.onrender.com/api";

// ---------- Authentification (jeton JWT conservé dans le navigateur) ----------
const TOKEN_KEY = "sat_token";
let authToken = null;
try { authToken = localStorage.getItem(TOKEN_KEY); } catch { authToken = null; }
const setAuthToken = (t) => {
  authToken = t;
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
};
let onUnauthorized = null; // appelé si le serveur répond 401 (session expirée)
const authFetch = async (url, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && authToken && onUnauthorized) onUnauthorized();
  return res;
};
// Message d'erreur renvoyé par le serveur (champ "detail")
const errDetail = async (res, fallback) => {
  try {
    const d = await res.json();
    return typeof d.detail === "string" ? d.detail : fallback;
  } catch {
    return fallback;
  }
};

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
  RTT: { color: "#10b981", label: "RTT" }, // vert (le télétravail n'existe plus)
  "Arrêt Maladie": { color: "#ef4444", label: "Arrêt maladie" },
  "Congé Sans Solde": { color: "#64748b", label: "Sans solde" },
  "Événement familial": { color: "#ec4899", label: "Événement familial" },
  "Visite médicale": { color: "#f97316", label: "Visite médicale" },
  Formation: { color: "#eab308", label: "Formation" },
};
// Types qui nécessitent un justificatif (le serveur fait foi)
// (une pièce jointe reste possible, en option, sur tous les autres types)
const JUSTIF_TYPES = ["Arrêt Maladie", "Événement familial", "Visite médicale"];
const LOGO_SRC = "/logo-sat.png"; // fichier à placer dans frontend/public/
const CANCELLED_OR_REJECTED = ["rejected", "cancelled"];
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
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
// Recherche insensible aux accents et à la casse ("jose" trouve "José")
const normalize = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// Exercice de congés SAT : du 1er mai au 30 avril
const exerciseStart = (d = new Date()) => (d.getMonth() >= 4 ? d.getFullYear() : d.getFullYear() - 1);
const inExercise = (dateStr, startYear) => dateStr >= `${startYear}-05-01` && dateStr < `${startYear + 1}-05-01`;
const halfLabel = (h) => (h === "morning" ? "matin" : "après-midi");

// Filtre de collaborateurs : liste déroulante à cases à cocher, avec recherche par nom OU matricule.
// selected === null  -> tout le monde ; sinon tableau d'identifiants cochés.
function PeopleFilter({ people, selected, onChange, label = "Collaborateurs" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const tokens = normalize(q).split(/\s+/).filter(Boolean);
  const shown = people.filter((p) => tokens.every((t) => normalize(`${p.matricule} ${p.full_name}`).includes(t)));
  const current = selected === null ? people.map((p) => p.id) : selected;
  const toggle = (id) => {
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    onChange(next.length === people.length ? null : next);
  };
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className="px-3 py-2 bg-white rounded-lg border border-slate-200 text-sm font-semibold flex items-center gap-2 cursor-pointer hover:bg-slate-50">
        <Users className="w-4 h-4" />
        {label} : {selected === null ? "tous" : `${selected.length} sélectionné(s)`}
        <ChevronDown className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 mt-2 w-80 max-w-[90vw] bg-white border border-slate-200 rounded-xl shadow-xl p-3 space-y-2">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher un nom ou un matricule…"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
            <div className="flex flex-wrap gap-3 text-xs font-semibold" style={{ color: "#6b4fd8" }}>
              <button type="button" onClick={() => onChange(null)} className="cursor-pointer hover:underline">Tout cocher</button>
              <button type="button" onClick={() => onChange([])} className="cursor-pointer hover:underline">Tout décocher</button>
              {q && (
                <button type="button" onClick={() => onChange(shown.map((p) => p.id))} className="cursor-pointer hover:underline">
                  Ne garder que ces {shown.length}
                </button>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
              {shown.map((p) => (
                <label key={p.id} className="flex items-center gap-2 py-1.5 text-sm cursor-pointer">
                  <input type="checkbox" checked={current.includes(p.id)} onChange={() => toggle(p.id)} />
                  <span className="font-mono text-xs text-slate-500 w-9 shrink-0">{p.matricule}</span>
                  <span className="truncate">{p.full_name}</span>
                </label>
              ))}
              {shown.length === 0 && <p className="py-3 text-center text-xs text-slate-400">Aucun résultat</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Erreur d'affichage", error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 640, margin: "60px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <h2 style={{ color: "#1b1f5e" }}>⚠️ Oups, l'application a rencontré une erreur</h2>
        <p style={{ color: "#475569" }}>
          Recharge la page (Ctrl + F5). Si ça recommence, envoie une capture de ce message :
        </p>
        <pre style={{ background: "#fef2f2", color: "#991b1b", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap", fontSize: 13 }}>
          {String(this.state.error && (this.state.error.stack || this.state.error.message || this.state.error)).slice(0, 700)}
        </pre>
        <button onClick={() => window.location.reload()}
          style={{ padding: "8px 16px", background: "#6b4fd8", color: "white", border: 0, borderRadius: 8, cursor: "pointer" }}>
          Recharger
        </button>
      </div>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const [user, setUser] = useState(null);
  const [emailInput, setEmailInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [booting, setBooting] = useState(!!authToken); // restauration de session en cours

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
  // Planning RH : vue Semaine / Mois / Année, zoom et filtre de collaborateurs
  const [planMode, setPlanMode] = useState("month");
  const [planAnchor, setPlanAnchor] = useState(new Date());
  const [planZoom, setPlanZoom] = useState(1);
  const [planPeople, setPlanPeople] = useState(null); // null = tout le monde, sinon liste d'identifiants
  // Saisie POUR un autre salarié (RH) ou formations (gestionnaire dédiée)
  const [targetUserId, setTargetUserId] = useState(""); // "" = moi-même
  const [directory, setDirectory] = useState([]);
  const [trainings, setTrainings] = useState([]);

  // Approbation
  const [adminTab, setAdminTab] = useState("todo");
  const [selectedId, setSelectedId] = useState(null);
  const [adminComments, setAdminComments] = useState({});

  // Création employé
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpEmail, setNewEmpEmail] = useState("");
  const [newEmpMatricule, setNewEmpMatricule] = useState("");
  const [newEmpBirth, setNewEmpBirth] = useState("");
  const [newEmpRole, setNewEmpRole] = useState("employee");
  const [empMsg, setEmpMsg] = useState("");
  const [rightsDraft, setRightsDraft] = useState({}); // droits en cours de saisie par la RH
  const [rightsMsg, setRightsMsg] = useState({ id: null, text: "" });
  const [empSearch, setEmpSearch] = useState("");
  const [openEmpId, setOpenEmpId] = useState(null);
  const [histScope, setHistScope] = useState("current"); // "current" | "all"
  const [managers, setManagers] = useState([]);    // liste déroulante « Manager / chantier »
  const [teamLeaves, setTeamLeaves] = useState([]);  // demandes de son équipe
  const [overrideId, setOverrideId] = useState(null); // RH qui décide à la place d'un manager
  const [apiError, setApiError] = useState("");

  // Sélection de dates + demande
  const [startDate, setStartDate] = useState("");
  const [startHalf, setStartHalf] = useState("morning");
  const [endDate, setEndDate] = useState("");
  const [endHalf, setEndHalf] = useState("afternoon");
  const [leaveType, setLeaveType] = useState("Congés Payés (CP)");
  const [employeeComment, setEmployeeComment] = useState("");
  const [formMessage, setFormMessage] = useState({ type: "", text: "" });
  const [showModal, setShowModal] = useState(false);
  const [managerId, setManagerId] = useState("");       // manager choisi dans la liste déroulante
  const [chainSteps, setChainSteps] = useState([]);     // aperçu du circuit de validation
  const [justifFiles, setJustifFiles] = useState([]);   // justificatifs joints à la demande en cours
  const [justifMsg, setJustifMsg] = useState({ id: null, text: "" });
  const [justifTab, setJustifTab] = useState("depose"); // vue RH : manquant | depose | recu
  const [justifSearch, setJustifSearch] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [pwdOld, setPwdOld] = useState("");
  const [pwdNew, setPwdNew] = useState("");
  const [pwdMsg, setPwdMsg] = useState("");
  const [exportFrom, setExportFrom] = useState(`${exerciseStart()}-05`);
  const [exportTo, setExportTo] = useState(`${exerciseStart() + 1}-04`);
  const [exportPeople, setExportPeople] = useState(null); // null = tout le monde
  const [exportZoom, setExportZoom] = useState(1);
  const [exportMsg, setExportMsg] = useState("");

  // Restaure la session au rechargement de la page (jeton encore valide)
  useEffect(() => {
    if (!authToken) return;
    (async () => {
      try {
        const res = await authFetch(`${API_URL}/me`);
        if (res.ok) setUser(await res.json());
        else setAuthToken(null);
      } catch (err) {
        console.error(err);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // Session expirée côté serveur -> retour à l'écran de connexion
  useEffect(() => {
    onUnauthorized = () => handleLogout("Session expirée, reconnecte-toi.");
    return () => { onUnauthorized = null; };
  });

  useEffect(() => {
    if (user) {
      fetchLeaves();
      fetchHolidays();
      fetchManagers();
      if (user.role === "admin") fetchEmployees();
      else fetchAssigned();
      if (user.can_manage_training) {
        fetchDirectory();
        fetchTrainings();
      }
      setView(user.role === "admin" ? "approval" : "calendar");
      if (user.must_change_password) setShowPwd(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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
          leave_type: leaveType,
          ...(targetUserId ? { for_user_id: targetUserId } : {}),
        });
        const res = await authFetch(`${API_URL}/leaves/preview?${params}`);
        if (res.ok) setPreviewData(await res.json());
      } catch (err) {
        console.error(err);
      }
    };
    run();
  }, [startDate, endDate, startHalf, endHalf, leaveType, targetUserId, user?.id]);

  // Aperçu du circuit de validation (selon le manager choisi)
  useEffect(() => {
    if (!showModal) return;
    const run = async () => {
      try {
        const res = await authFetch(`${API_URL}/leaves/chain${managerId ? `?manager_id=${managerId}` : ""}`);
        if (res.ok) setChainSteps(await res.json());
      } catch (err) {
        console.error(err);
      }
    };
    run();
  }, [showModal, managerId]);

  // Le message de succès disparaît tout seul
  useEffect(() => {
    if (formMessage.type === "success") {
      const t = setTimeout(() => setFormMessage({ type: "", text: "" }), 6000);
      return () => clearTimeout(t);
    }
  }, [formMessage]);

  const fetchHolidays = async () => {
    try {
      const res = await authFetch(`${API_URL}/holidays`);
      setHolidaysMap(await res.json());
    } catch (err) {
      console.error("Erreur chargement jours fériés", err);
    }
  };

  const fetchLeaves = async () => {
    try {
      const res = await authFetch(`${API_URL}/leaves`); // le serveur ne renvoie que ce que tu as le droit de voir
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) throw new Error(`Chargement des congés impossible (code ${res.status}).`);
      setLeaves(data);
      setApiError("");
    } catch (err) {
      console.error("Erreur lors du chargement des congés", err);
      setApiError(`${err.message} Le serveur est peut-être en train de se réveiller : réessaie dans une minute.`);
    }
  };

  // Demandes dont je suis valideur (manager choisi, valideur de confirmation, manager imposé…)
  const fetchAssigned = async () => {
    try {
      const res = await authFetch(`${API_URL}/leaves/assigned`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setTeamLeaves(data);
    } catch (err) {
      console.error("Erreur chargement des demandes à valider", err);
    }
  };

  // Annuaire (nom + matricule) pour saisir une absence « pour » quelqu'un
  const fetchDirectory = async () => {
    try {
      const res = await authFetch(`${API_URL}/directory`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setDirectory(data);
    } catch (err) {
      console.error(err);
    }
  };

  // Formations saisies par la gestionnaire
  const fetchTrainings = async () => {
    try {
      const res = await authFetch(`${API_URL}/trainings`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setTrainings(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchManagers = async () => {
    try {
      const res = await authFetch(`${API_URL}/managers`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setManagers(data);
    } catch (err) {
      console.error("Erreur chargement des managers", err);
    }
  };

  const fetchEmployees = async () => {
    try {
      const res = await authFetch(`${API_URL}/users`);
      const data = await res.json();
      if (Array.isArray(data)) setEmployees(data);
    } catch (err) {
      console.error("Erreur chargement employés", err);
    }
  };

  // ---------- Connexion ----------
  const handleLogin = async (e) => {
    if (e) e.preventDefault();
    setLoginError("");
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailInput.trim().toLowerCase(), password: passwordInput.trim() }),
      });
      if (!res.ok) throw new Error(await errDetail(res, `Connexion impossible (code ${res.status}).`));
      const data = await res.json();
      setAuthToken(data.token);
      setUser(data.user);
      setEmailInput("");
      setPasswordInput("");
    } catch (err) {
      setLoginError(
        err.message === "Failed to fetch"
          ? "Serveur injoignable. Il est peut-être en train de se réveiller : réessaie dans une minute."
          : err.message
      );
    }
  };

  const handleLogout = (message = "") => {
    setAuthToken(null);
    setUser(null);
    setLeaves([]);
    setEmployees([]);
    setTeamLeaves([]);
    setManagers([]);
    setSelectedId(null);
    setLoginError(typeof message === "string" ? message : "");
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwdMsg("");
    try {
      const res = await authFetch(`${API_URL}/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_password: pwdOld, new_password: pwdNew }),
      });
      if (!res.ok) throw new Error(await errDetail(res, "Le mot de passe doit contenir au moins 8 caractères."));
      setPwdOld("");
      setPwdNew("");
      setPwdMsg("✅ Mot de passe modifié.");
      setUser({ ...user, must_change_password: false });
      setTimeout(() => { setShowPwd(false); setPwdMsg(""); }, 1500);
    } catch (err) {
      setPwdMsg(`❌ ${err.message}`);
    }
  };

  // ---------- Collaborateurs ----------
  const handleAddEmployee = async (e) => {
    e.preventDefault();
    setEmpMsg("");
    try {
      const res = await authFetch(`${API_URL}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matricule: newEmpMatricule.trim(),
          full_name: newEmpName.trim(),
          email: newEmpEmail.trim(),
          birth_date: newEmpBirth,
          role: newEmpRole,
        }),
      });
      if (!res.ok) throw new Error(await errDetail(res, "Erreur lors de l'ajout (vérifie les champs)."));
      setNewEmpName("");
      setNewEmpEmail("");
      setNewEmpMatricule("");
      setNewEmpBirth("");
      setNewEmpRole("employee");
      setEmpMsg("✅ Collaborateur ajouté. Mot de passe initial : jour et mois de naissance (JJMM).");
      fetchEmployees();
    } catch (err) {
      setEmpMsg(`❌ ${err.message}`);
    }
  };

  const handleDeleteEmployee = async (id, name) => {
    if (!window.confirm(`Désactiver le compte de ${name} ? Il ne pourra plus se connecter (son historique est conservé).`)) return;
    try {
      const res = await authFetch(`${API_URL}/users/${id}`, { method: "DELETE" });
      if (res.ok) {
        fetchEmployees();
        fetchLeaves();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // ---------- Sélection sur le calendrier ----------
  const handleMarkSeen = async (leaveId) => {
    try {
      await authFetch(`${API_URL}/leaves/${leaveId}/seen`, { method: "PATCH" });
      fetchLeaves();
    } catch (err) {
      console.error(err);
    }
  };

  // Manager IMPOSÉ : le salarié ne choisit plus (circuit : manager imposé -> Christophe, RH notifiée)
  const handleSetFixedManager = async (emp, value) => {
    try {
      const res = await authFetch(`${API_URL}/users/${emp.id}/fixed-manager`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manager_id: value === "" ? null : Number(value) }),
      });
      if (!res.ok) {
        alert(await errDetail(res, "Erreur lors du changement de manager imposé"));
        return;
      }
      fetchEmployees();
    } catch (err) {
      console.error(err);
    }
  };

  const handleSetRole = async (emp, role) => {
    try {
      const res = await authFetch(`${API_URL}/users/${emp.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        alert(await errDetail(res, "Erreur lors du changement de rôle"));
        return;
      }
      fetchEmployees();
      fetchManagers();
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveRights = async (emp) => {
    const d = rightsDraft[emp.id];
    if (!d) return;
    const body = {};
    ["droits_cp", "droits_fractionnement", "droits_rtt", "cp_deja_pris"].forEach((k) => {
      if (d[k] !== undefined && d[k] !== "") body[k] = parseFloat(String(d[k]).replace(",", "."));
    });
    try {
      const res = await authFetch(`${API_URL}/users/${emp.id}/rights`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Valeur invalide : saisis un nombre entre 0 et 100.");
      const copy = { ...rightsDraft };
      delete copy[emp.id];
      setRightsDraft(copy);
      setRightsMsg({ id: emp.id, text: "Droits enregistrés ✓" });
      fetchEmployees();
    } catch (err) {
      setRightsMsg({ id: emp.id, text: err.message });
    }
  };

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

  const goTo = (key) => {
    if (key === "training") {
      setLeaveType("Formation");
      setTargetUserId("");
      resetSelection();
    } else if (view === "training") {
      setLeaveType("Congés Payés (CP)");
      setTargetUserId("");
      resetSelection();
    } else if (key === "calendar") {
      setTargetUserId("");
    }
    setView(key);
  };

  const resetSelection = () => {
    setStartDate("");
    setEndDate("");
    setStartHalf("morning");
    setEndHalf("afternoon");
    setEmployeeComment("");
    setJustifFiles([]);
  };

  // ---------- Envoi de la demande ----------
  const handleCreateLeave = async (e) => {
    e.preventDefault();
    setFormMessage({ type: "", text: "" });
    const onBehalf = !!targetUserId;
    const targetName = (directoryList.find((p) => String(p.id) === String(targetUserId)) || {}).full_name || "";
    try {
      const res = await authFetch(`${API_URL}/leaves`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: startDate,
          start_half_day: startHalf,
          end_date: endDate,
          end_half_day: endHalf,
          leave_type: leaveType,
          employee_comment: employeeComment,
          manager_id: onBehalf || user.role === "manager" || user.fixed_manager_id || !managerId ? null : Number(managerId),
          for_user_id: onBehalf ? Number(targetUserId) : null,
        }),
      });
      if (!res.ok) throw new Error(await errDetail(res, "Erreur lors de l'envoi"));
      const created = await res.json();

      // Justificatifs joints dès la demande (facultatif)
      let uploadError = "";
      const files = justifFiles;
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        const up = await authFetch(`${API_URL}/leaves/${created.id}/justificatifs`, { method: "POST", body: fd });
        if (!up.ok) {
          uploadError = await errDetail(up, "Le justificatif n'a pas pu être déposé.");
          break;
        }
      }

      setShowModal(false);
      resetSelection();
      setFormMessage({
        type: "success",
        text: onBehalf
          ? `✅ Absence enregistrée pour ${targetName} (${leaveType}, ${created.days_count} jour(s)) : elle est validée directement.`
          : `Demande envoyée ! Prochain valideur : ${created.awaiting_name}. La RH est informée.` +
            (uploadError ? ` ⚠️ ${uploadError} Tu pourras le rajouter depuis « Mon calendrier ».` : ""),
      });
      fetchLeaves();
      if (user.role !== "admin") fetchAssigned();
      if (user.can_manage_training) fetchTrainings();
      if (!onBehalf) {
        // Met à jour les soldes affichés (calculés par le serveur) puis retour sur mon calendrier
        const me = await authFetch(`${API_URL}/me`);
        if (me.ok) setUser(await me.json());
        setView("calendar");
      }
    } catch (err) {
      setFormMessage({ type: "error", text: err.message });
    }
  };

  const handleCancelLeave = async (leaveId) => {
    if (!window.confirm("Annuler cette demande ? Les jours seront recrédités.")) return;
    try {
      const res = await authFetch(`${API_URL}/leaves/${leaveId}/cancel`, { method: "PATCH" });
      if (!res.ok) {
        alert(await errDetail(res, "Annulation impossible."));
        return;
      }
      fetchLeaves();
      if (user.role !== "admin") fetchAssigned();
      const me = await authFetch(`${API_URL}/me`);
      if (me.ok) setUser(await me.json());
    } catch (err) {
      console.error(err);
    }
  };

  // ---------- Validation / refus ----------
  const handleUpdateStatus = async (leaveId, newStatus) => {
    try {
      const res = await authFetch(`${API_URL}/leaves/${leaveId}/decision`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, comment: adminComments[leaveId] || "" }),
      });
      if (res.ok) {
        setSelectedId(null);
        setOverrideId(null);
        fetchLeaves();
        if (user.role === "admin") fetchEmployees();
        else fetchAssigned();
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.detail || "Erreur lors de la décision");
      }
    } catch (err) {
      console.error("Erreur lors de la mise à jour", err);
    }
  };

  // ---------- Justificatifs ----------
  const handleUploadJustif = async (leaveId, fileList) => {
    setJustifMsg({ id: leaveId, text: "" });
    try {
      for (const f of Array.from(fileList)) {
        if (f.size > 5 * 1024 * 1024) {
          setJustifMsg({ id: leaveId, text: `« ${f.name} » dépasse 5 Mo.` });
          return;
        }
        const fd = new FormData();
        fd.append("file", f);
        const res = await authFetch(`${API_URL}/leaves/${leaveId}/justificatifs`, { method: "POST", body: fd });
        if (!res.ok) {
          setJustifMsg({ id: leaveId, text: await errDetail(res, "Dépôt impossible.") });
          return;
        }
      }
      setJustifMsg({ id: leaveId, text: "Justificatif déposé ✓" });
      fetchLeaves();
    } catch (err) {
      setJustifMsg({ id: leaveId, text: "Dépôt impossible (serveur injoignable)." });
    }
  };

  const handleDeleteJustif = async (j) => {
    if (!window.confirm(`Supprimer « ${j.filename} » ?`)) return;
    try {
      const res = await authFetch(`${API_URL}/justificatifs/${j.id}`, { method: "DELETE" });
      if (!res.ok) alert(await errDetail(res, "Suppression impossible."));
      fetchLeaves();
    } catch (err) {
      console.error(err);
    }
  };

  // Le fichier est protégé : on le télécharge avec le jeton puis on l'affiche dans un nouvel onglet
  const openJustif = async (j) => {
    const w = window.open("", "_blank");
    try {
      const res = await authFetch(`${API_URL}/justificatifs/${j.id}`);
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      if (w) w.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      if (w) w.close();
      alert("Impossible d'ouvrir ce justificatif.");
    }
  };

  const handleSetRecu = async (leaveId, recu) => {
    try {
      const res = await authFetch(`${API_URL}/leaves/${leaveId}/justificatif`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recu }),
      });
      if (!res.ok) alert(await errDetail(res, "Erreur"));
      fetchLeaves();
    } catch (err) {
      console.error(err);
    }
  };

  // ---------- Export Excel : planning (salariés choisis, période en mois) ----------
  const downloadPlanning = async (ids, from, to) => {
    setExportMsg("");
    try {
      const q = `start=${from}&end=${to}${ids && ids.length ? `&user_ids=${ids.join(",")}` : ""}`;
      const res = await authFetch(`${API_URL}/export/planning?${q}`);
      if (!res.ok) throw new Error(await errDetail(res, "Export impossible."));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `planning_SAT_${from}_${to}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setExportMsg(`❌ ${err.message}`);
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
      l.status === "approved" ? "Valide" : l.status === "rejected" ? "Refuse" : l.status === "cancelled" ? "Annule" : "En attente",
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
  if (booting && !user) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center p-4 text-white text-sm"
        style={{ background: `linear-gradient(135deg, ${NAVY}, ${PURPLE})` }}>
        Connexion au serveur… (peut prendre jusqu'à une minute au réveil)
      </div>
    );
  }

  if (!user) {
    return (
      <div
        className="min-h-screen w-full flex items-center justify-center p-4"
        style={{ background: `linear-gradient(135deg, ${NAVY}, ${PURPLE})` }}
      >
        <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8">
          <img src={LOGO_SRC} alt="SAT" className="w-28 h-28 object-contain mx-auto mb-2" />
          <h1 className="text-2xl font-bold text-center" style={{ color: NAVY }}>
            SAT • Espace Congés
          </h1>
          <p className="text-center text-slate-500 text-sm mt-1 mb-8">
            Connectez-vous avec votre adresse email et votre mot de passe
          </p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Email professionnel
              </label>
              <input
                type="email"
                required
                placeholder="prenom.nom@sat-idf.fr"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-[#6b4fd8] outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Mot de passe</label>
              <input
                type="password"
                required
                autoComplete="current-password"
                placeholder="Jour et mois de naissance (ex. 1306)"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
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

          <p className="mt-6 text-xs text-slate-400 text-center">
            Mot de passe oublié ? Contacte la RH.
          </p>
        </div>
      </div>
    );
  }

  // =========================================================================
  // DONNÉES DÉRIVÉES
  // =========================================================================
  const isAdmin = user.role === "admin";
  // « À moi de valider » : mon étape du circuit (manager choisi, confirmation, manager imposé) ou étape RH
  const myTurn = (l) =>
    l.status === "pending" &&
    l.user_id !== user.id &&
    (l.awaiting_approver_id === user.id || (isAdmin && l.awaiting_kind === "rh"));
  const pendingLeaves = leaves.filter(myTurn);                                   // RH : à traiter
  const progressLeaves = leaves.filter((l) => l.status === "pending" && !myTurn(l)); // RH : en cours chez un autre valideur
  const doneLeaves = leaves
    .filter((l) => l.status === "approved" || l.status === "rejected")
    .sort((a, b) => (a.rh_seen === b.rh_seen ? (a.created_at < b.created_at ? 1 : -1) : a.rh_seen ? 1 : -1));
  const unseenCount = doneLeaves.filter((l) => !l.rh_seen).length;                 // décisions pas encore « vues » par la RH
  const pendingCount = pendingLeaves.length;
  // Valideur non-RH
  const teamPending = teamLeaves.filter(myTurn);
  const teamDone = teamLeaves.filter((l) => !myTurn(l));
  const team = Object.values(
    teamLeaves.reduce((acc, l) => {
      if (l.employee.id !== user.id) acc[l.employee.id] = l.employee;
      return acc;
    }, {})
  );
  const isApprover = !isAdmin && (user.role === "manager" || user.role === "confirmer" || teamLeaves.length > 0);
  const planLeaves = isAdmin ? leaves : [...leaves, ...teamLeaves];
  const justifDeposed = leaves.filter(
    (l) => l.justificatif_requis && !l.justificatif_recu && l.justificatifs.length > 0 && !CANCELLED_OR_REJECTED.includes(l.status)
  ).length;
  const today = new Date();
  const todayKey = formatYMD(today);
  // Personnes pour lesquelles on peut saisir une absence : tous (RH) ou annuaire (gestionnaire des formations)
  const directoryList = isAdmin ? employees : directory;

  const nav = isAdmin
    ? [
        { key: "approval", label: "Approbation", icon: Check, badge: pendingCount + unseenCount },
        { key: "justificatifs", label: "Justificatifs", icon: Paperclip, badge: justifDeposed },
        { key: "planning", label: "Planning", icon: Eye },
        { key: "employees", label: "Collaborateurs", icon: Users },
        { key: "exports", label: "Exports", icon: Download },
        { key: "calendar", label: "Mon calendrier", icon: CalendarDays },
        { key: "request", label: "Demande", icon: Send },
      ]
    : [
        { key: "calendar", label: "Mon calendrier", icon: CalendarDays },
        { key: "request", label: "Demande", icon: Send },
        ...(isApprover ? [{ key: "team", label: "À valider", icon: Users, badge: teamPending.length }] : []),
        ...(user.can_manage_training ? [{ key: "training", label: "Formations", icon: Users }] : []),
      ];

  // Congé d'un utilisateur à une date (hors week-end / férié / refusé)
  const leaveOnDay = (userId, d) => {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return null;
    const key = formatYMD(d);
    if (holidaysMap[key]) return null;
    return (
      planLeaves.find(
        (l) =>
          l.user_id === userId &&
          !CANCELLED_OR_REJECTED.includes(l.status) &&
          l.start_date <= key &&
          l.end_date >= key
      ) || null
    );
  };

  // Demi-journées d'un jour : { am: demande du matin, pm: demande de l'après-midi } (null = libre)
  const halvesOnDay = (userId, d) => {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return { am: null, pm: null };
    const key = formatYMD(d);
    if (holidaysMap[key]) return { am: null, pm: null };
    let am = null;
    let pm = null;
    planLeaves.forEach((l) => {
      if (l.user_id !== userId || CANCELLED_OR_REJECTED.includes(l.status) || l.start_date > key || l.end_date < key) return;
      if (!(key === l.start_date && l.start_half_day === "afternoon")) am = l;
      if (!(key === l.end_date && l.end_half_day === "morning")) pm = l;
    });
    return { am, pm };
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
    if (status === "cancelled")
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">
          <X className="w-3.5 h-3.5" /> Annulé
        </span>
      );
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
        <Hourglass className="w-3.5 h-3.5" /> En attente
      </span>
    );
  };

  // Suivi du circuit : Rita ✓ → Édouard ⏳ → Christophe
  const renderSteps = (l) => {
    if (!l.steps || l.steps.length === 0) return null;
    const cur = l.status === "pending" ? l.steps.find((st) => st.status === "pending") : null;
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {l.steps.map((st, i) => {
          let cls = "bg-slate-100 text-slate-500";
          let mark = "";
          if (st.status === "approved") { cls = "bg-emerald-100 text-emerald-800"; mark = "✓ "; }
          else if (st.status === "rejected") { cls = "bg-rose-100 text-rose-800"; mark = "✗ "; }
          else if (cur && st.position === cur.position) { cls = "bg-amber-100 text-amber-800"; mark = "⏳ "; }
          return (
            <React.Fragment key={st.position}>
              {i > 0 && <ChevronRight className="w-3 h-3 text-slate-400" />}
              <span
                className={`px-2 py-0.5 rounded-full font-semibold ${cls}`}
                title={st.decided_by_name && st.decided_by_name !== st.approver_name ? `Décidé par ${st.decided_by_name}` : ""}
              >
                {mark}{st.approver_name}
              </span>
            </React.Fragment>
          );
        })}
        <span className="text-slate-400">· RH informée</span>
      </div>
    );
  };

  // Justificatifs d'une demande (visibles uniquement par le salarié et la RH)
  const renderJustifBlock = (l, who) => {
    if (CANCELLED_OR_REJECTED.includes(l.status)) return null;
    const files = l.justificatifs || [];
    const addButton = (
      <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer text-xs">
        <Plus className="w-3.5 h-3.5" /> Ajouter un justificatif (PDF, JPG, PNG — 5 Mo max)
        <input type="file" multiple accept="application/pdf,image/jpeg,image/png" className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length) handleUploadJustif(l.id, e.target.files);
            e.target.value = "";
          }} />
      </label>
    );
    // Type sans justificatif obligatoire et rien de joint : simple bouton discret
    if (!l.justificatif_requis && files.length === 0) {
      return (
        <div>
          {addButton}
          {justifMsg.id === l.id && justifMsg.text && <p className="text-xs font-medium text-[#3b2a8f] mt-1">{justifMsg.text}</p>}
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2 text-xs">
        <p className="font-semibold flex items-center gap-1.5 text-slate-700">
          <Paperclip className="w-3.5 h-3.5" />
          {l.justificatif_recu
            ? "Justificatif reçu par la RH ✓"
            : files.length > 0
            ? "Justificatif déposé — en cours de vérification par la RH"
            : l.justificatif_requis
            ? "Justificatif à fournir"
            : "Pièce jointe"}
        </p>
        {files.map((j) => (
          <div key={j.id} className="flex items-center gap-2">
            <button onClick={() => openJustif(j)} className="underline text-[#3b2a8f] cursor-pointer text-left truncate">
              {j.filename}
            </button>
            <span className="text-slate-400">{fmtSize(j.size)}</span>
            {(who === "rh" || !l.justificatif_recu) && (
              <button onClick={() => handleDeleteJustif(j)} title="Supprimer"
                className="text-slate-400 hover:text-rose-600 cursor-pointer">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
        {!l.justificatif_recu && files.length < 5 && addButton}
        {justifMsg.id === l.id && justifMsg.text && <p className="font-medium text-[#3b2a8f]">{justifMsg.text}</p>}
      </div>
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
    const viewUserId = targetUserId ? Number(targetUserId) : user.id;

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
                    const hv = halvesOnDay(viewUserId, d);
                    const lv = hv.am || hv.pm;
                    const partial = !!lv && hv.am !== hv.pm; // demi-journée : demi-case
                    const isToday = key === todayKey;
                    const blocked = weekend || !!holiday;

                    const inSel =
                      selectable &&
                      startDate &&
                      key >= startDate &&
                      key <= (endDate || startDate);
                    // Sélection en cours : demi-case si on part l'après-midi ou si on revient à midi
                    const selAm = !(key === startDate && startHalf === "afternoon");
                    const selPm = !(key === lastSelKey && endHalf === "morning");
                    const selPartial = inSel && !(selAm && selPm);
                    const roundL = inSel && !selPartial && (key === startDate || dow === 1 || d.getDate() === 1);
                    const roundR = inSel && !selPartial && (key === lastSelKey || dow === 0 || d.getDate() === lastDom);
                    const selStyle = !inSel
                      ? {}
                      : selPartial
                      ? { background: `linear-gradient(90deg, ${selAm ? SELECT_COLOR : "transparent"} 50%, ${selPm ? SELECT_COLOR : "transparent"} 50%)` }
                      : { backgroundColor: SELECT_COLOR };

                    let cls = "text-slate-700";
                    let style = {};
                    let title = "";
                    if (inSel && !blocked) {
                      cls = selPartial ? "text-slate-900 font-bold" : "text-white font-bold";
                    } else if (weekend) {
                      cls = "text-slate-400";
                      style = { backgroundColor: WEEKEND_BG, ...hatchStyle };
                    } else if (holiday) {
                      cls = "text-[#3b2a8f] font-semibold";
                      style = { backgroundColor: HOLIDAY_BG };
                      title = holiday;
                    } else if (lv) {
                      cls = lv.status === "approved" && !partial ? "text-white font-semibold" : "text-slate-900 font-semibold";
                      style = partial ? {} : leaveCellStyle(lv);
                      title = `${partial ? (hv.am ? "Matin : " : "Après-midi : ") : ""}${lv.leave_type} (${lv.status === "approved" ? "validé" : "en attente"})`;
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
                        style={selStyle}
                      >
                        <button
                          type="button"
                          disabled={!selectable || blocked}
                          onClick={() => handleDayClick(d)}
                          title={title}
                          className={`relative overflow-hidden w-8 h-8 rounded-full flex items-center justify-center text-sm ${cls} ${
                            isToday ? "ring-2 ring-slate-900" : ""
                          } ${
                            selectable && !blocked && !inSel
                              ? "cursor-pointer hover:ring-2 hover:ring-[#6b4fd8]/50"
                              : ""
                          }`}
                          style={inSel && !blocked ? { backgroundColor: "transparent" } : style}
                        >
                          {partial && !(inSel && !blocked) && (
                            <>
                              <span className="absolute inset-y-0 left-0 w-1/2" style={hv.am ? leaveCellStyle(hv.am) : {}} />
                              <span className="absolute inset-y-0 right-0 w-1/2" style={hv.pm ? leaveCellStyle(hv.pm) : {}} />
                            </>
                          )}
                          <span className="relative">{content}</span>
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
      .filter((l) => !CANCELLED_OR_REJECTED.includes(l.status))
      .forEach((l) => {
        byType[l.leave_type] = byType[l.leave_type] || { approved: 0, pending: 0 };
        byType[l.leave_type][l.status === "approved" ? "approved" : "pending"] += l.days_count;
      });
    const totalApproved = myLeaves
      .filter((l) => l.status === "approved")
      .reduce((s, l) => s + l.days_count, 0);

    return (
      <div className="space-y-6">
        {formMessage.type === "success" && (
          <div className="p-3 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-800 border border-emerald-200">
            {formMessage.text}
          </div>
        )}
        {renderCalendarGrid(false)}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-[#ece8fb]">🏖️</div>
            <div>
              <p className="text-sm text-slate-600">Solde Congés Payés (CP)</p>
              <p className="text-2xl font-extrabold" style={{ color: NAVY }}>{user?.solde_cp} jour(s)</p>
            </div>
          </div>
          
          <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-[#e0f2fe]">⏱️</div>
            <div>
              <p className="text-sm text-slate-600">Solde RTT</p>
              <p className="text-2xl font-extrabold" style={{ color: NAVY }}>{user?.solde_rtt} jour(s)</p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-[#f1f5f9]">📅</div>
            <div>
              <p className="text-sm text-slate-600">Absences validées</p>
              <p className="text-2xl font-extrabold" style={{ color: NAVY }}>{totalApproved} jour(s)</p>
            </div>
          </div>
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
        </div>

        <div>
          <h2 className="text-xl font-extrabold mb-3" style={{ color: NAVY }}>Mes demandes</h2>
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
            {myLeaves.length === 0 ? (
              <p className="p-8 text-center text-sm text-slate-400">Aucune demande.</p>
            ) : (
              myLeaves.map((l) => (
                <div key={l.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                        <TypeDot type={l.leave_type} /> {l.leave_type}
                      </p>
                      <p className="text-xs text-slate-600">
                        Du {fmtFR(l.start_date)} au {fmtFR(l.end_date)} ({l.days_count} jour(s))
                      </p>
                      {l.admin_comment && (
                        <p className="text-xs text-slate-500 mt-1">
                          Réponse{l.decided_by_name ? ` de ${l.decided_by_name}` : ""} : « {l.admin_comment} »
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      {renderStatusPill(l.status)}
                      {l.status === "pending" && (
                        <button onClick={() => handleCancelLeave(l.id)}
                          className="text-xs font-semibold text-slate-500 hover:text-rose-600 underline cursor-pointer">
                          Annuler
                        </button>
                      )}
                    </div>
                  </div>
                  {l.status !== "cancelled" && renderSteps(l)}
                  {renderJustifBlock(l, "owner")}
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
  const renderRequest = (opts = {}) => {
    const training = !!opts.training; // onglet « Formations » de la gestionnaire
    const people = directoryList.filter((p) => p.id !== user.id);
    const canContinue =
      startDate && endDate && endDate >= startDate && previewData.days_count > 0 && (!training || !!targetUserId);
    return (
      <div className="space-y-4">
        {formMessage.type === "success" && (
          <div className="p-3 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-800 border border-emerald-200">
            {formMessage.text}
          </div>
        )}

        {(training || isAdmin) && (
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center gap-3">
            <label className="text-sm font-semibold" style={{ color: NAVY }}>
              {training ? "Collaborateur en formation" : "Pour qui ?"}
            </label>
            <select
              value={targetUserId}
              onChange={(e) => {
                setTargetUserId(e.target.value);
                resetSelection();
              }}
              className="min-w-[260px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:ring-2 focus:ring-[#6b4fd8] outline-none"
            >
              <option value="">{training ? "Choisir un collaborateur…" : "Moi-même"}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.matricule} — {p.full_name}</option>
              ))}
            </select>
            {targetUserId ? (
              <span className="text-xs text-slate-500">
                {training
                  ? "La formation est enregistrée directement dans son planning."
                  : "Saisie à sa place : l'absence est enregistrée directement, sans circuit de validation."}
              </span>
            ) : training ? (
              <span className="text-xs text-amber-700">Choisis d'abord un collaborateur pour afficher son calendrier.</span>
            ) : null}
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
              {targetUserId ? "Poursuivre la saisie" : "Poursuivre ma demande"}
            </button>
            <button
              onClick={resetSelection}
              className="px-3 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Annuler
            </button>
          </div>
        </div>

        {training && (
          <div className="bg-white rounded-xl border border-slate-200">
            <p className="px-4 py-3 text-sm font-bold border-b border-slate-100" style={{ color: NAVY }}>
              Formations que j'ai saisies ({trainings.length})
            </p>
            {trainings.length === 0 ? (
              <p className="p-6 text-center text-sm text-slate-400">Aucune formation saisie pour le moment.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {trainings.map((t) => (
                  <div key={t.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div>
                      <p className="font-semibold text-slate-900">{t.matricule} — {t.employee_name}</p>
                      <p className="text-xs text-slate-500">
                        Du {fmtFR(t.start_date)} ({halfLabel(t.start_half_day)}) au {fmtFR(t.end_date)} ({t.end_half_day === "morning" ? "midi" : "fin de journée"}) · {t.days_count} jour(s)
                      </p>
                    </div>
                    <button
                      onClick={() => handleCancelLeave(t.id)}
                      className="text-xs font-semibold text-slate-500 hover:text-rose-600 underline cursor-pointer"
                    >
                      Annuler cette formation
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // =========================================================================
  // POP-UP : FINALISER LA DEMANDE
  // =========================================================================
  const renderModal = () => {
    const onBehalf = !!targetUserId;
    const targetName = (directoryList.find((p) => String(p.id) === String(targetUserId)) || {}).full_name || "";
    const overlap = leaves.some(
      (l) =>
        l.user_id === (onBehalf ? Number(targetUserId) : user.id) &&
        !CANCELLED_OR_REJECTED.includes(l.status) &&
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
              <h2 className="text-xl font-extrabold" style={{ color: NAVY }}>
                {onBehalf ? `Absence de ${targetName}` : "Finaliser ma demande"}
              </h2>
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
                {(view === "training" ? ["Formation"] : Object.keys(TYPE_STYLES)).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          {!onBehalf && !["admin", "manager"].includes(user.role) && (
            <div>
              <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Manager / chantier</label>
              {user.fixed_manager_id ? (
                <p className="text-sm px-3 py-2.5 rounded-lg bg-slate-100 text-slate-700">
                  {user.fixed_manager_name} <span className="text-xs text-slate-500">(valideur imposé)</span>
                </p>
              ) : (
                <select
                  value={managerId}
                  onChange={(e) => setManagerId(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 bg-white text-sm focus:ring-2 focus:ring-[#6b4fd8] outline-none"
                >
                  <option value="">Aucun : la RH valide directement</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          {onBehalf && (
            <p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-3">
              Saisie à la place de <strong>{targetName}</strong> : l'absence est <strong>enregistrée directement</strong> (aucun circuit de validation). Il en est informé par email, et la RH aussi.
            </p>
          )}
          {!onBehalf && chainSteps.length > 0 && (
            <p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-3">
              Circuit de validation : <strong>{chainSteps.map((st) => st.approver_name).join(" → ")}</strong>.
              La RH est informée à chaque étape.
            </p>
          )}

          {(
            <div className={`p-3 rounded-lg border text-xs space-y-2 ${
              JUSTIF_TYPES.includes(leaveType) ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-slate-50 border-slate-200 text-slate-700"
            }`}>
              <p>
                📎 {JUSTIF_TYPES.includes(leaveType)
                  ? "Ce type d'absence nécessite un justificatif"
                  : "Pièce jointe (facultative)"}{" "}
                — PDF, JPG ou PNG, 5 Mo max. Tu peux la joindre maintenant ou plus tard depuis « Mon calendrier ».
              </p>
              <input
                type="file"
                multiple
                accept="application/pdf,image/jpeg,image/png"
                onChange={(e) => setJustifFiles(Array.from(e.target.files || []))}
                className="block w-full text-xs"
              />
            </div>
          )}

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
              <Send className="w-4 h-4" /> {onBehalf ? "Enregistrer l'absence" : "Envoyer la demande"}
            </button>
          </div>
        </form>
      </div>
    );
  };

  // =========================================================================
  // GRILLE DE PLANNING (vue RH + aperçu de l'export) : 1 ligne par personne, 1 colonne par jour,
  // demi-case pour une demi-journée (gauche = matin, droite = après-midi)
  // =========================================================================
  const renderPlanGrid = (rows, rangeStart, rangeEnd, cellPx, maxHeight, zoom = 1) => {
    const days = [];
    for (let d = new Date(rangeStart); d < rangeEnd; d = addDays(d, 1)) days.push(d);
    const months = [];
    days.forEach((d) => {
      const k = `${d.getFullYear()}-${d.getMonth()}`;
      const last = months[months.length - 1];
      if (last && last.k === k) last.n += 1;
      else months.push({ k, n: 1, d });
    });
    const byUser = {};
    planLeaves.forEach((l) => {
      if (!CANCELLED_OR_REJECTED.includes(l.status)) (byUser[l.user_id] = byUser[l.user_id] || []).push(l);
    });
    const MAT_W = 76;
    const NAME_W = 270;
    const HEAD1 = 30;
    const HEAD2 = 42;
    // Le zoom agit sur la largeur MINIMALE des jours, la hauteur des lignes et la taille du texte
    const ROW_H = Math.min(48, Math.max(18, Math.round(30 * zoom)));
    const FONT = Math.min(16, Math.max(10, Math.round(13 * zoom)));
    const showDow = cellPx >= 14;
    const showNum = cellPx >= 10;
    const wideHeader = cellPx >= 60;
    const edge = (d) => ({ borderLeft: d.getDate() === 1 ? "1px solid #94a3b8" : "1px solid #eef0f8" });
    const todayTint = "rgba(107,79,216,0.09)";

    return (
      <div className="bg-white rounded-xl border border-slate-200 overflow-auto" style={maxHeight ? { maxHeight } : {}}>
        {/* Les jours se partagent toute la largeur disponible ; en dessous de la largeur minimale, on fait défiler */}
        <table className="border-collapse" style={{ tableLayout: "fixed", width: "100%", minWidth: MAT_W + NAME_W + days.length * cellPx, fontSize: FONT }}>
          <colgroup>
            <col style={{ width: MAT_W }} />
            <col style={{ width: NAME_W }} />
            {days.map((d) => <col key={d.toISOString()} />)}
          </colgroup>
          <thead>
            <tr style={{ height: HEAD1 }}>
              <th className="sticky left-0 top-0 z-30 bg-white" />
              <th className="sticky top-0 z-30 bg-white" style={{ left: MAT_W }} />
              {months.map((m, idx) => {
                // Mois étroit (vue Année) : nom abrégé, avec l'année en janvier et au tout début
                const narrow = cellPx * m.n < 110;
                const label = narrow
                  ? m.d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", "") +
                    (idx === 0 || m.d.getMonth() === 0 ? ` ${String(m.d.getFullYear()).slice(2)}` : "")
                  : m.d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
                return (
                  <th key={m.k} colSpan={m.n}
                    className="sticky top-0 z-20 bg-white text-left px-2 text-xs font-bold capitalize whitespace-nowrap overflow-hidden"
                    style={{ color: NAVY, borderLeft: "1px solid #94a3b8" }}>
                    {label}
                  </th>
                );
              })}
            </tr>
            <tr style={{ height: HEAD2 }}>
              <th className="sticky left-0 z-30 bg-white text-[11px] font-semibold text-slate-500 text-left px-2 align-bottom pb-1.5" style={{ top: HEAD1 }}>Matricule</th>
              <th className="sticky z-30 bg-white text-[11px] font-semibold text-slate-500 text-left px-2 align-bottom pb-1.5" style={{ left: MAT_W, top: HEAD1 }}>Collaborateur</th>
              {days.map((d) => {
                const isToday = formatYMD(d) === todayKey;
                const weekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <th key={d.toISOString()} className="sticky z-20 p-0 text-center font-medium align-bottom"
                    style={{ top: HEAD1, ...edge(d), backgroundColor: weekend ? WEEKEND_BG : "#fff" }}>
                    {showDow && (
                      <div className="text-[9px] leading-3 text-slate-400 uppercase text-center">
                        {d.toLocaleDateString("fr-FR", { weekday: wideHeader ? "short" : "narrow" })}
                      </div>
                    )}
                    {showNum && (
                      <div className={`mx-auto text-center text-[11px] leading-5 mb-1 ${isToday ? "text-white rounded-full font-bold" : "text-slate-600"}`}
                        style={isToday ? { backgroundColor: PURPLE, width: 20, height: 20 } : {}}>
                        {d.getDate()}
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((emp) => {
              const lvs = byUser[emp.id] || [];
              return (
                <tr key={emp.id} style={{ height: ROW_H }}>
                  <td className="sticky left-0 z-10 bg-white px-2 border-t border-slate-100 font-mono text-slate-500" style={{ fontSize: "0.85em" }}>{emp.matricule}</td>
                  <td className="sticky z-10 bg-white px-2 border-t border-slate-100 text-slate-800 whitespace-nowrap overflow-hidden text-ellipsis"
                    style={{ left: MAT_W, boxShadow: "inset -1px 0 0 #e2e8f0" }} title={emp.full_name}>
                    {emp.full_name}
                  </td>
                  {days.map((d) => {
                    const key = formatYMD(d);
                    const weekend = d.getDay() === 0 || d.getDay() === 6;
                    const holiday = holidaysMap[key];
                    let am = null;
                    let pm = null;
                    if (!weekend && !holiday) {
                      for (const l of lvs) {
                        if (l.start_date > key || l.end_date < key) continue;
                        if (!(key === l.start_date && l.start_half_day === "afternoon")) am = l;
                        if (!(key === l.end_date && l.end_half_day === "morning")) pm = l;
                      }
                    }
                    const bg = weekend ? WEEKEND_BG : holiday ? HOLIDAY_BG : key === todayKey ? todayTint : undefined;
                    const label = (l, part) =>
                      `${emp.full_name} — ${part}${l.leave_type} (${l.status === "approved" ? "validé" : "en attente"})`;
                    if (am && am === pm) {
                      return <td key={key} title={label(am, "")} className="border-t border-slate-100 p-0" style={{ ...leaveCellStyle(am), ...edge(d) }} />;
                    }
                    if (am || pm) {
                      return (
                        <td key={key} title={am ? label(am, "matin : ") : label(pm, "après-midi : ")}
                          className="border-t border-slate-100 p-0" style={{ backgroundColor: bg, ...edge(d) }}>
                          <div className="flex" style={{ height: ROW_H - 1 }}>
                            <div style={{ flex: 1, ...(am ? leaveCellStyle(am) : {}) }} />
                            <div style={{ flex: 1, ...(pm ? leaveCellStyle(pm) : {}) }} />
                          </div>
                        </td>
                      );
                    }
                    return <td key={key} title={holiday || ""} className="border-t border-slate-100 p-0" style={{ backgroundColor: bg, ...edge(d) }} />;
                  })}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={days.length + 2} className="p-8 text-center text-sm text-slate-400">Aucun collaborateur sélectionné.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  };

  const zoomButtons = (zoom, setZoom) => (
    <div className="flex items-center bg-white rounded-lg border border-slate-200 overflow-hidden">
      <button onClick={() => setZoom(Math.max(0.4, +(zoom - 0.2).toFixed(1)))} title="Dézoomer" className="px-3 py-2 hover:bg-slate-50 cursor-pointer">
        <ZoomOut className="w-4 h-4" />
      </button>
      <button onClick={() => setZoom(1)} title="Taille d'origine" className="px-2 text-xs font-semibold text-slate-600 border-x border-slate-200 h-full py-2.5 hover:bg-slate-50 cursor-pointer">
        {Math.round(zoom * 100)} %
      </button>
      <button onClick={() => setZoom(Math.min(3, +(zoom + 0.2).toFixed(1)))} title="Zoomer" className="px-3 py-2 hover:bg-slate-50 cursor-pointer">
        <ZoomIn className="w-4 h-4" />
      </button>
    </div>
  );

  // =========================================================================
  // VUE : PLANNING (RH) — semaine / mois / année, zoom, filtre de personnes
  // =========================================================================
  const renderPlanning = () => {
    const people = employees;
    const rows = planPeople === null ? people : people.filter((p) => planPeople.includes(p.id));
    const a = planAnchor;
    let rs, re, label;
    if (planMode === "week") {
      rs = mondayOf(a);
      re = addDays(rs, 7);
      label = `Semaine ${isoWeek(rs)} · ${rs.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} – ${addDays(re, -1).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
    } else if (planMode === "month") {
      rs = new Date(a.getFullYear(), a.getMonth(), 1);
      re = new Date(a.getFullYear(), a.getMonth() + 1, 1);
      label = rs.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    } else {
      const y0 = exerciseStart(a);
      rs = new Date(y0, 4, 1);
      re = new Date(y0 + 1, 4, 1);
      label = `Exercice ${y0}/${y0 + 1} (mai → avril)`;
    }
    const base = { week: 78, month: 30, year: 2.2 }[planMode];
    const cellPx = Math.max(2, base * planZoom);
    const shift = (dir) => {
      if (planMode === "week") setPlanAnchor(addDays(a, 7 * dir));
      else if (planMode === "month") setPlanAnchor(new Date(a.getFullYear(), a.getMonth() + dir, 1));
      else setPlanAnchor(new Date(a.getFullYear() + dir, a.getMonth(), 1));
    };
    const modes = [["week", "Semaine"], ["month", "Mois"], ["year", "Année"]];

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 bg-[#e8ebf8] p-3 rounded-xl">
          <div className="flex bg-white rounded-lg border border-slate-200 overflow-hidden">
            {modes.map(([k, l]) => (
              <button key={k} onClick={() => { setPlanMode(k); setPlanZoom(1); }}
                className={`px-4 py-2 text-sm font-semibold cursor-pointer ${planMode === k ? "text-white" : "hover:bg-slate-50 text-slate-700"}`}
                style={planMode === k ? { backgroundColor: PURPLE } : {}}>
                {l}
              </button>
            ))}
          </div>
          <div className="flex bg-white rounded-lg border border-slate-200 overflow-hidden">
            <button onClick={() => shift(-1)} className="px-3 py-2 hover:bg-slate-50 cursor-pointer"><ChevronLeft className="w-4 h-4" /></button>
            <button onClick={() => shift(1)} className="px-3 py-2 border-l border-slate-200 hover:bg-slate-50 cursor-pointer"><ChevronRight className="w-4 h-4" /></button>
          </div>
          <button onClick={() => setPlanAnchor(new Date())}
            className="px-4 py-2 bg-white rounded-lg border border-slate-200 text-sm font-semibold hover:bg-slate-50 cursor-pointer">
            Aujourd'hui
          </button>
          <span className="text-sm font-bold capitalize" style={{ color: NAVY }}>{label}</span>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {zoomButtons(planZoom, setPlanZoom)}
            <PeopleFilter people={people} selected={planPeople} onChange={setPlanPeople} />
            <button onClick={() => { setTargetUserId(""); resetSelection(); setView("request"); }}
              className="px-4 py-2 text-white rounded-lg text-sm font-semibold cursor-pointer hover:opacity-90 flex items-center gap-2"
              style={{ backgroundColor: PURPLE }}>
              <Plus className="w-4 h-4" /> Saisir une absence
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-500">{rows.length} collaborateur(s) affiché(s) · demi-case = demi-journée (gauche : matin, droite : après-midi)</p>
          {renderLegend()}
        </div>
        {renderPlanGrid(rows, rs, re, cellPx, "calc(100vh - 285px)", planZoom)}
      </div>
    );
  };

  // =========================================================================
  // VUE : APPROBATION (liste + détail)
  // =========================================================================
  const renderApproval = (mode = "rh") => {
    const isMgr = mode === "manager";
    const tabs = isMgr
      ? [
          { key: "todo", label: "À valider", list: teamPending, count: teamPending.length },
          { key: "done", label: "Suivies", list: teamDone, count: teamDone.length },
        ]
      : [
          { key: "todo", label: "À traiter", list: pendingLeaves, count: pendingLeaves.length },
          { key: "progress", label: "En cours", list: progressLeaves, count: progressLeaves.length },
          { key: "done", label: "Traitées", list: doneLeaves, count: doneLeaves.length, fresh: unseenCount },
        ];
    const activeTab = tabs.some((t) => t.key === adminTab) ? adminTab : "todo";
    const list = tabs.find((t) => t.key === activeTab).list;
    const selected = (isMgr ? teamLeaves : leaves).find((l) => l.id === selectedId);
    // On ne décide que si c'est son tour ; la RH peut décider à la place d'un valideur après l'avoir demandé explicitement
    const canDecide =
      selected &&
      selected.status === "pending" &&
      selected.user_id !== user.id &&
      (myTurn(selected) || (isAdmin && overrideId === selected.id));

    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 bg-white rounded-xl border border-slate-200 overflow-hidden min-h-[520px]">
        <div className="lg:col-span-5 border-r border-slate-200">
          <div className="flex border-b border-slate-200">
            {tabs.map((t) => (
              <button key={t.key} onClick={() => { setAdminTab(t.key); setSelectedId(null); }}
                className={`flex items-center gap-2 px-4 py-4 text-sm font-medium cursor-pointer border-b-2 ${
                  activeTab === t.key ? "bg-[#f3f0ff] border-[#6b4fd8] text-[#6b4fd8]" : "border-transparent text-slate-600 hover:bg-slate-50"
                }`}>
                {t.label}
                <span className="px-2 py-0.5 rounded-full text-xs bg-[#ddd6fb] text-[#3b2a8f] font-semibold">{t.count}</span>
                {t.fresh > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] text-white font-bold" style={{ backgroundColor: PURPLE }}>
                    {t.fresh} nouveau{t.fresh > 1 ? "x" : ""}
                  </span>
                )}
              </button>
            ))}
          </div>
          {activeTab === "progress" && (
            <p className="px-6 py-3 text-xs text-slate-500 bg-slate-50 border-b border-slate-100">
              Ces demandes sont en cours de validation chez un manager ou un valideur. Vous êtes simplement informé(e).
            </p>
          )}
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
                    {!isMgr && activeTab === "done" && !l.rh_seen && (
                      <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ backgroundColor: PURPLE }} title="Non vu" />
                    )}
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
                  {activeTab !== "todo" && (
                    <p className="text-xs text-slate-500 mt-0.5">
                      {l.status === "pending"
                        ? `En attente de : ${l.awaiting_name}`
                        : l.decided_by_name
                        ? `Décision de ${l.decided_by_name}`
                        : ""}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-7 bg-[#f6f7ff] flex items-center justify-center p-8">
          {!selected ? (
            <div className="text-center text-slate-400">
              <Mail className="w-24 h-24 mx-auto text-[#d9d4f7]" strokeWidth={1} />
              <p className="mt-3 text-sm">Sélectionnez une demande pour la consulter ou la traiter</p>
            </div>
          ) : (
            <div className="w-full max-w-lg bg-white rounded-xl border border-slate-200 p-6 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-extrabold" style={{ color: NAVY }}>{selected.employee.full_name}</h3>
                  <p className="text-xs text-slate-500">{selected.employee.email}</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Solde actuel : <strong>{selected.employee.solde_cp} CP</strong> · <strong>{selected.employee.solde_rtt} RTT</strong>
                  </p>
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
                  <p className="font-semibold">{selected.days_count} jour(s)</p>
                </div>
                <div className="bg-[#f3f0ff] rounded-lg p-3 col-span-2">
                  <p className="text-xs text-slate-500">Période</p>
                  <p className="font-semibold">
                    Du {fmtFR(selected.start_date)} ({halfLabel(selected.start_half_day)}) au{" "}
                    {fmtFR(selected.end_date)} ({halfLabel(selected.end_half_day)})
                  </p>
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-xs text-slate-500">
                  Circuit de validation{selected.manager_name ? ` — manager : ${selected.manager_name}` : " — sans manager : la RH valide"}
                </p>
                {renderSteps(selected)}
              </div>

              {selected.employee_comment && (
                <p className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3 italic">
                  💬 « {selected.employee_comment} »
                </p>
              )}

              {/* Pièces médicales : visibles uniquement par la RH */}
              {isAdmin && renderJustifBlock(selected, "rh")}

              {canDecide ? (
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
              ) : selected.status === "pending" ? (
                <div className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 space-y-2">
                  {selected.user_id === user.id ? (
                    <p>C'est ta propre demande : elle est validée par un autre valideur.</p>
                  ) : (
                    <p>
                      En attente de la décision de <strong>{selected.awaiting_name}</strong>. La RH est simplement informée.
                    </p>
                  )}
                  {isAdmin && selected.user_id !== user.id && (
                    <button onClick={() => setOverrideId(selected.id)}
                      className="text-xs font-semibold underline cursor-pointer">
                      Décider à sa place (absence du valideur, par exemple)
                    </button>
                  )}
                </div>
              ) : (
                selected.admin_comment && (
                  <p className="text-sm text-slate-600">
                    Note {selected.decided_by_name ? `de ${selected.decided_by_name}` : "RH"} : « {selected.admin_comment} »
                  </p>
                )
              )}

              {!isMgr && selected.status !== "pending" && selected.status !== "cancelled" && !selected.rh_seen && (
                <button onClick={() => handleMarkSeen(selected.id)}
                  className="w-full py-2 text-sm font-semibold rounded-lg border border-slate-300 hover:bg-slate-50 cursor-pointer">
                  Marquer comme vu
                </button>
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
  const renderEmployees = () => {
    const tokens = normalize(empSearch).split(/\s+/).filter(Boolean);
    const filtered = employees.filter((e) =>
      tokens.every((t) => normalize(`${e.full_name} ${e.email} ${e.matricule}`).includes(t))
    );
    const exYear = exerciseStart();
    const sumDays = (list) => list.reduce((sum, l) => sum + l.days_count, 0);

    const renderEmpDetails = (emp) => {
      const mine = leaves.filter((l) => l.user_id === emp.id);
      const cur = mine.filter((l) => inExercise(l.start_date, exYear));
      const stat = (type) => {
        const list = cur.filter((l) => l.leave_type === type);
        return {
          approved: sumDays(list.filter((l) => l.status === "approved")),
          pending: sumDays(list.filter((l) => l.status === "pending")),
        };
      };
      const CP = "Congés Payés (CP)";
      const cpStat = stat(CP);
      const rttStat = stat("RTT");
      const cpTotal = (emp.droits_cp || 0) + (emp.droits_fractionnement || 0);
      const others = {};
      cur
        .filter((l) => l.status === "approved" && l.leave_type !== CP && l.leave_type !== "RTT")
        .forEach((l) => { others[l.leave_type] = (others[l.leave_type] || 0) + l.days_count; });
      const shown = (histScope === "current" ? cur : mine)
        .slice()
        .sort((x, y) => (x.start_date < y.start_date ? 1 : -1));

      const d = rightsDraft[emp.id] || {};
      const val = (k) => (d[k] !== undefined ? d[k] : emp[k]);
      const setVal = (k, v) => setRightsDraft({ ...rightsDraft, [emp.id]: { ...d, [k]: v } });

      const balanceBox = (title, color, droits, st, dispo) => (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-bold uppercase flex items-center gap-2" style={{ color }}>
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: color }} /> {title}
          </p>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            {[["Droits", droits], ["Validés", st.approved], ["En attente", st.pending], ["Disponible", dispo]].map(([label, v], i) => (
              <div key={label}>
                <p className="text-xl font-extrabold" style={{ color: i === 3 ? color : NAVY }}>{v}</p>
                <p className="text-[10px] uppercase text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        </div>
      );

      return (
        <>
          <div>
            <p className="text-xs font-semibold uppercase text-slate-500 mb-2">
              Situation actuelle — exercice du 01/05/{exYear} au 30/04/{exYear + 1}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {balanceBox("Congés payés (CP + fractionnement)", typeColor(CP), cpTotal, cpStat, emp.solde_cp)}
              {balanceBox("RTT", typeColor("RTT"), emp.droits_rtt, rttStat, emp.solde_rtt)}
            </div>
            <p className="text-xs text-slate-600 mt-2">
              Samedis décomptés : <strong>{emp.samedis_utilises}/5</strong>
              {Object.entries(others).map(([t, n]) => (
                <span key={t}> · {TYPE_STYLES[t] ? TYPE_STYLES[t].label : t} : <strong>{n} j</strong></span>
              ))}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase text-slate-500 mb-2">Rôle</p>
              {["employee", "manager"].includes(emp.role) ? (
                <select value={emp.role} onChange={(e) => handleSetRole(emp, e.target.value)}
                  className="px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8] bg-white">
                  <option value="employee">Salarié</option>
                  <option value="manager">Manager (apparaît dans la liste déroulante des demandes)</option>
                </select>
              ) : (
                <p className="text-sm text-slate-600">
                  {emp.role === "confirmer" ? `Valideur de confirmation (étape ${emp.confirm_order})` : "Administrateur RH"}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-slate-500 mb-2">Manager imposé</p>
              <div className="flex flex-wrap items-center gap-3">
                <select value={emp.fixed_manager_id ?? ""} onChange={(e) => handleSetFixedManager(emp, e.target.value)}
                  className="px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8] bg-white">
                  <option value="">Aucun : {emp.full_name} choisit son manager</option>
                  {employees.filter((m) => m.id !== emp.id).map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
                </select>
                <span className="text-xs text-slate-500">
                  {emp.fixed_manager_id
                    ? "Circuit : manager imposé → Christophe, la RH est notifiée."
                    : "Il choisit son manager à chaque demande."}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={() => downloadPlanning([emp.id], `${exYear}-05`, `${exYear + 1}-04`)}
                className="px-3 py-2 text-white text-xs font-semibold rounded-lg flex items-center gap-2 cursor-pointer hover:opacity-90"
                style={{ backgroundColor: PURPLE }}>
                <Download className="w-4 h-4" /> Planning annuel (Excel)
              </button>
              <button onClick={() => { setTargetUserId(String(emp.id)); resetSelection(); setLeaveType("Congés Payés (CP)"); setView("request"); }}
                className="px-3 py-2 text-xs font-semibold rounded-lg flex items-center gap-2 cursor-pointer border border-slate-300 hover:bg-slate-50">
                <Plus className="w-4 h-4" /> Saisir une absence pour {emp.full_name.split(" ")[0]}
              </button>
              <span className="text-xs text-slate-500">Exercice {exYear}/{exYear + 1}</span>
              {exportMsg && <span className="text-xs text-rose-600">{exportMsg}</span>}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase text-slate-500 mb-3">Droits de l'exercice (modifiables par la RH)</p>
            <div className="flex flex-wrap items-end gap-3">
              {[
                ["droits_cp", "CP (principale + 5e sem. + anc.)"],
                ["droits_fractionnement", "Fractionnement"],
                ["droits_rtt", "RTT"],
                ["cp_deja_pris", "CP déjà pris (reprise Excel)"],
              ].map(([key, label]) => (
                <label key={key} className="text-[11px] font-semibold uppercase text-slate-500">
                  {label}
                  <input type="number" min="0" step="0.5" value={val(key)}
                    onChange={(e) => setVal(key, e.target.value)}
                    className="block w-28 mt-1 px-2 py-1.5 rounded-lg border border-slate-300 text-sm font-normal normal-case text-slate-900 outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
                </label>
              ))}
              <button onClick={() => handleSaveRights(emp)} disabled={Object.keys(d).length === 0}
                className="px-3 py-1.5 text-white text-xs font-semibold rounded-lg cursor-pointer hover:opacity-90 disabled:opacity-30 disabled:cursor-default"
                style={{ backgroundColor: PURPLE }}>
                Enregistrer
              </button>
              {rightsMsg.id === emp.id && rightsMsg.text && (
                <span className="text-xs font-medium text-[#3b2a8f]">{rightsMsg.text}</span>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-xs font-semibold uppercase text-slate-500">
                Historique des demandes ({shown.length})
              </p>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
                {[["current", "Exercice en cours"], ["all", "Tout l'historique"]].map(([k, label]) => (
                  <button key={k} onClick={() => setHistScope(k)}
                    className="px-3 py-1.5 cursor-pointer"
                    style={histScope === k ? { backgroundColor: PURPLE, color: "white" } : { color: "#475569" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-slate-500 py-4 text-center">Aucune demande sur cette période.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3">Période</th>
                      <th className="py-2 pr-3">Jours</th>
                      <th className="py-2 pr-3">Statut</th>
                      <th className="py-2">Commentaires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => (
                      <tr key={l.id} className="border-b border-slate-100 align-top">
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span className="inline-flex items-center gap-2">
                            <TypeDot type={l.leave_type} />
                            {TYPE_STYLES[l.leave_type] ? TYPE_STYLES[l.leave_type].label : l.leave_type}
                          </span>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          Du {fmtFR(l.start_date)}{l.start_half_day === "afternoon" ? " (après-midi)" : ""} au {fmtFR(l.end_date)}{l.end_half_day === "morning" ? " (matin)" : ""}
                        </td>
                        <td className="py-2 pr-3 font-semibold">{l.days_count}</td>
                        <td className="py-2 pr-3">{renderStatusPill(l.status)}</td>
                        <td className="py-2 text-xs text-slate-500">
                          {l.employee_comment && <p>👤 {l.employee_comment}</p>}
                          {l.admin_comment && <p>🛡️ RH : {l.admin_comment}</p>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      );
    };

    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-4 bg-white p-6 rounded-xl border border-slate-200 h-fit">
        <h2 className="text-lg font-extrabold mb-1" style={{ color: NAVY }}>Ajouter un collaborateur</h2>
        <p className="text-xs text-slate-500 mb-4">Mot de passe initial : jour et mois de naissance (JJMM).</p>
        <form onSubmit={handleAddEmployee} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Nom et prénom</label>
            <input type="text" required placeholder="Ex : Sophie Martin" value={newEmpName}
              onChange={(e) => setNewEmpName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Email professionnel</label>
            <input type="email" required placeholder="sophie.martin@sat-idf.fr" value={newEmpEmail}
              onChange={(e) => setNewEmpEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Matricule</label>
              <input type="text" required placeholder="Ex : 320" value={newEmpMatricule}
                onChange={(e) => setNewEmpMatricule(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Date de naissance</label>
              <input type="date" required value={newEmpBirth}
                onChange={(e) => setNewEmpBirth(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Rôle</label>
            <select value={newEmpRole} onChange={(e) => setNewEmpRole(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]">
              <option value="employee">Salarié</option>
              <option value="manager">Manager (chantier)</option>
            </select>
          </div>
          {empMsg && <p className="text-xs font-medium text-[#3b2a8f] bg-[#ece8fb] p-2.5 rounded-lg">{empMsg}</p>}
          <button type="submit"
            className="w-full py-2.5 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer hover:opacity-90"
            style={{ backgroundColor: PURPLE }}>
            <Plus className="w-4 h-4" /> Créer le compte
          </button>
        </form>
      </div>


        <div className="lg:col-span-8 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="p-5 border-b border-slate-200 space-y-3">
            <h2 className="text-lg font-extrabold" style={{ color: NAVY }}>
              Effectif ({filtered.length}{tokens.length > 0 ? ` sur ${employees.length}` : ""})
            </h2>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input type="text" value={empSearch} onChange={(e) => setEmpSearch(e.target.value)}
                placeholder="Rechercher par nom ou prénom…"
                className="w-full pl-9 pr-9 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
              {empSearch && (
                <button onClick={() => setEmpSearch("")} title="Effacer"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
          <div className="divide-y divide-slate-100">
            {filtered.length === 0 && (
              <p className="p-8 text-sm text-slate-500 text-center">Aucun collaborateur ne correspond à cette recherche.</p>
            )}
            {filtered.map((emp) => {
              const isAdmin = emp.role === "admin";
              const open = openEmpId === emp.id && !isAdmin;
              const pendingN = leaves.filter((l) => l.user_id === emp.id && l.status === "pending").length;
              return (
                <div key={emp.id}>
                  <div className="flex items-center hover:bg-slate-50">
                    <button onClick={() => !isAdmin && setOpenEmpId(open ? null : emp.id)}
                      className={`flex-1 min-w-0 p-4 flex items-center gap-3 text-left ${isAdmin ? "cursor-default" : "cursor-pointer"}`}>
                      <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${isAdmin ? "opacity-0" : "text-slate-400"} ${open ? "rotate-180" : ""}`} />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm text-slate-900 truncate">
                          {emp.full_name}
                          {isAdmin && (
                            <span className="ml-2 text-[10px] uppercase px-2 py-0.5 bg-[#ddd6fb] text-[#3b2a8f] rounded-full font-bold">
                              Admin RH
                            </span>
                          )}
                          {!isAdmin && emp.is_manager && (
                            <span className="ml-2 text-[10px] uppercase px-2 py-0.5 bg-sky-100 text-sky-800 rounded-full font-bold">
                              Manager
                            </span>
                          )}
                          {!isAdmin && emp.role === "confirmer" && (
                            <span className="ml-2 text-[10px] uppercase px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full font-bold">
                              Valideur
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500 truncate">
                          n° {emp.matricule} · {emp.email}{emp.statut ? ` · ${emp.statut}` : ""}
                          {emp.fixed_manager_name ? ` · Manager imposé : ${emp.fixed_manager_name}` : ""}
                        </p>
                      </div>
                      {!isAdmin && (
                        <div className="hidden sm:flex items-center gap-2 text-xs shrink-0">
                          <span className="px-2 py-0.5 rounded-full bg-[#ece8fb] text-[#3b2a8f] font-semibold">CP {emp.solde_cp}</span>
                          <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 font-semibold">RTT {emp.solde_rtt}</span>
                          {pendingN > 0 && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">{pendingN} en attente</span>
                          )}
                        </div>
                      )}
                    </button>
                    {!isAdmin && (
                      <button onClick={() => handleDeleteEmployee(emp.id, emp.full_name)}
                        className="p-2 mr-3 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer" title="Désactiver le compte">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {open && <div className="px-4 pb-5 pt-1 space-y-4 bg-slate-50/70">{renderEmpDetails(emp)}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // =========================================================================
  // VUE : EXPORTS
  // =========================================================================
  const renderExports = () => {
    const people = employees;
    const rows = exportPeople === null ? people : people.filter((p) => exportPeople.includes(p.id));
    const parse = (v) => (/^\d{4}-\d{2}$/.test(v) ? new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, 1) : null);
    const fromD = parse(exportFrom);
    const toLast = parse(exportTo);
    const toD = toLast ? new Date(toLast.getFullYear(), toLast.getMonth() + 1, 1) : null;
    const nDays = fromD && toD ? Math.round((toD - fromD) / 86400000) : 0;
    const validPeriod = !!fromD && !!toD && toD > fromD && nDays <= 800;
    const base = nDays <= 45 ? 26 : nDays <= 100 ? 14 : nDays <= 200 ? 6 : 2.2;
    const cellPx = Math.max(2, base * exportZoom);
    const ey = exerciseStart();
    const presets = [
      ["Exercice en cours", `${ey}-05`, `${ey + 1}-04`],
      ["Exercice précédent", `${ey - 1}-05`, `${ey}-04`],
      ["Mois en cours", formatYMD(today).slice(0, 7), formatYMD(today).slice(0, 7)],
    ];
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-xl">
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

        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div>
            <h2 className="text-lg font-extrabold mb-1" style={{ color: NAVY }}>Planning Excel</h2>
            <p className="text-sm text-slate-500">
              Choisis la période (en mois) et les collaborateurs : l'Excel reprend le tableau coloré de l'application,
              avec les demi-journées en demi-cases. L'aperçu ci-dessous montre exactement ce qui sera exporté.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Du mois de</label>
              <input type="month" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)}
                className="px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase text-slate-600 mb-1">Au mois de (inclus)</label>
              <input type="month" value={exportTo} onChange={(e) => setExportTo(e.target.value)}
                className="px-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
            </div>
            <PeopleFilter people={people} selected={exportPeople} onChange={setExportPeople} />
            {zoomButtons(exportZoom, setExportZoom)}
          </div>
          <div className="flex flex-wrap gap-2">
            {presets.map(([l, f, t]) => (
              <button key={l} onClick={() => { setExportFrom(f); setExportTo(t); }}
                className="px-3 py-1.5 text-xs font-semibold rounded-full border border-slate-300 hover:bg-slate-50 cursor-pointer">
                {l}
              </button>
            ))}
          </div>

          {!validPeriod ? (
            <p className="text-sm text-rose-600">
              Période invalide : le mois de fin doit être égal ou postérieur au mois de début (24 mois maximum).
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                Aperçu · {rows.length} collaborateur(s) · du {fromD.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })} au{" "}
                {toLast.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
              </p>
              {renderPlanGrid(rows, fromD, toD, cellPx, 400, exportZoom)}
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              disabled={!validPeriod || rows.length === 0}
              onClick={() => downloadPlanning(exportPeople, exportFrom, exportTo)}
              className="px-5 py-2.5 text-white text-sm font-semibold rounded-lg flex items-center gap-2 cursor-pointer hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: PURPLE }}>
              <Download className="w-4 h-4" /> Télécharger le planning (.xlsx)
            </button>
            {exportMsg && <p className="text-sm text-rose-600">{exportMsg}</p>}
          </div>
        </div>
      </div>
    );
  };

  // =========================================================================
  // VUE : JUSTIFICATIFS (RH) — filtre : à fournir / déposés / reçus
  // =========================================================================
  const renderJustificatifs = () => {
    const needing = leaves.filter((l) => l.justificatif_requis && !CANCELLED_OR_REJECTED.includes(l.status));
    const tokens = normalize(justifSearch).split(/\s+/).filter(Boolean);
    const buckets = {
      manquant: needing.filter((l) => !l.justificatif_recu && l.justificatifs.length === 0),
      depose: needing.filter((l) => !l.justificatif_recu && l.justificatifs.length > 0),
      recu: needing.filter((l) => l.justificatif_recu),
    };
    const tabs = [
      ["manquant", "À fournir"],
      ["depose", "Déposés (à vérifier)"],
      ["recu", "Reçus"],
    ];
    const list = buckets[justifTab]
      .filter((l) => tokens.every((t) => normalize(l.employee.full_name).includes(t)))
      .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));

    return (
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex flex-wrap items-center border-b border-slate-200">
          {tabs.map(([key, label]) => (
            <button key={key} onClick={() => setJustifTab(key)}
              className={`flex items-center gap-2 px-4 py-4 text-sm font-medium cursor-pointer border-b-2 ${
                justifTab === key ? "bg-[#f3f0ff] border-[#6b4fd8] text-[#6b4fd8]" : "border-transparent text-slate-600 hover:bg-slate-50"
              }`}>
              {label}
              <span className="px-2 py-0.5 rounded-full text-xs bg-[#ddd6fb] text-[#3b2a8f] font-semibold">{buckets[key].length}</span>
            </button>
          ))}
          <div className="relative ml-auto mr-4 my-2">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="text" value={justifSearch} onChange={(e) => setJustifSearch(e.target.value)}
              placeholder="Rechercher un salarié…"
              className="pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
          </div>
        </div>
        {list.length === 0 ? (
          <p className="p-10 text-center text-sm text-slate-400">Rien à afficher ici.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {list.map((l) => (
              <div key={l.id} className="p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                      <TypeDot type={l.leave_type} /> {l.employee.full_name} — {l.leave_type}
                    </p>
                    <p className="text-xs text-slate-600 flex items-center gap-2 mt-0.5">
                      Du {fmtFR(l.start_date)} au {fmtFR(l.end_date)} ({l.days_count} jour(s)) {renderStatusPill(l.status)}
                    </p>
                  </div>
                  <button onClick={() => handleSetRecu(l.id, !l.justificatif_recu)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                      l.justificatif_recu ? "border border-slate-300 text-slate-700 hover:bg-slate-50" : "text-white hover:opacity-90"
                    }`}
                    style={l.justificatif_recu ? {} : { backgroundColor: PURPLE }}>
                    {l.justificatif_recu ? "Annuler « reçu »" : "Marquer comme reçu"}
                  </button>
                </div>
                {renderJustifBlock(l, "rh")}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // =========================================================================
  // POP-UP : CHANGER MON MOT DE PASSE
  // =========================================================================
  const renderPasswordModal = () => (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={() => !user.must_change_password && setShowPwd(false)}>
      <form onSubmit={handleChangePassword} onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-extrabold" style={{ color: NAVY }}>Changer mon mot de passe</h2>
          {!user.must_change_password && (
            <button type="button" onClick={() => setShowPwd(false)}
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        {user.must_change_password && (
          <p className="text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3">
            Pour ta sécurité, choisis un nouveau mot de passe personnel.
          </p>
        )}
        <input type="password" required autoComplete="current-password" placeholder="Mot de passe actuel"
          value={pwdOld} onChange={(e) => setPwdOld(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
        <input type="password" required minLength={8} autoComplete="new-password"
          placeholder="Nouveau mot de passe (8 caractères minimum)"
          value={pwdNew} onChange={(e) => setPwdNew(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-[#6b4fd8]" />
        {pwdMsg && <p className="text-xs font-medium text-[#3b2a8f] bg-[#ece8fb] p-2.5 rounded-lg">{pwdMsg}</p>}
        <button type="submit"
          className="w-full py-2.5 text-white text-sm font-semibold rounded-lg cursor-pointer hover:opacity-90"
          style={{ backgroundColor: PURPLE }}>
          Enregistrer
        </button>
      </form>
    </div>
  );

  const titles = {
    calendar: "Mon calendrier",
    request: "Demande d'absence",
    planning: "Planning",
    approval: "Approbation",
    employees: "Collaborateurs",
    exports: "Exports",
    team: "Demandes à valider",
    justificatifs: "Justificatifs",
    training: "Formations",
  };

  // =========================================================================
  // LAYOUT PRINCIPAL (pleine largeur)
  // =========================================================================
  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row" style={{ backgroundColor: PAGE_BG }}>
      {/* Sidebar desktop */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col text-white sticky top-0 h-screen" style={{ backgroundColor: NAVY }}>
        <div className="px-5 py-6 flex items-center gap-3">
          <img src={LOGO_SRC} alt="SAT" className="w-11 h-11 rounded-xl bg-white object-contain p-0.5" />
          <span className="font-extrabold text-lg">SAT Congés</span>
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {nav.map((n) => {
            const Icon = n.icon;
            const active = view === n.key;
            return (
              <button key={n.key} onClick={() => goTo(n.key)}
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
          <button onClick={() => setShowPwd(true)}
            className="flex items-center gap-2 text-sm text-white/80 hover:text-white cursor-pointer mb-2">
            <Lock className="w-4 h-4" /> Mot de passe
          </button>
          <button onClick={handleLogout}
            className="flex items-center gap-2 text-sm text-white/80 hover:text-white cursor-pointer">
            <LogOut className="w-4 h-4" /> Déconnexion
          </button>
        </div>
      </aside>

      {/* Barre mobile */}
      <header className="md:hidden text-white" style={{ backgroundColor: NAVY }}>
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-extrabold flex items-center gap-2">
            <img src={LOGO_SRC} alt="SAT" className="w-8 h-8 rounded-lg bg-white object-contain" /> SAT Congés
          </span>
          <div className="flex items-center gap-4">
            <button onClick={() => setShowPwd(true)} className="text-white/80 cursor-pointer" title="Mot de passe">
              <Lock className="w-5 h-5" />
            </button>
            <button onClick={handleLogout} className="text-white/80 cursor-pointer" title="Déconnexion">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex overflow-x-auto px-2 pb-2 gap-1">
          {nav.map((n) => {
            const Icon = n.icon;
            const active = view === n.key;
            return (
              <button key={n.key} onClick={() => goTo(n.key)}
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
        {apiError && (
          <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">⚠️ {apiError}</div>
        )}
        {view === "calendar" && renderCalendar()}
        {view === "request" && renderRequest()}
        {view === "training" && renderRequest({ training: true })}
        {view === "planning" && renderPlanning()}
        {view === "approval" && renderApproval("rh")}
        {view === "team" && renderApproval("manager")}
        {view === "employees" && renderEmployees()}
        {view === "exports" && renderExports()}
        {view === "justificatifs" && renderJustificatifs()}
      </main>

      {showModal && renderModal()}
      {showPwd && renderPasswordModal()}
    </div>
  );
}