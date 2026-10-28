"use strict";

// Demande de matières premières OBLIGATOIRE avant la création d'une fiche de
// production (PROMESH / PROBAR) — uniquement pour les comptes et postes
// listés ici (par défaut : production_1@cbi-tunisia.com, poste Matin).
//
// Règle nominative (par email) et non par rôle : production_1..5 et
// responsable_logistique partagent le rôle `responsable_logistique_achat`
// (même principe que config/productionWorkflow.js). Tous les autres comptes,
// postes et modules (maintenance) ne sont jamais concernés. Les fiches
// MÉLANGE n'ont pas de poste : celui du compte est déduit de ses horaires
// (sessionPosteFor).

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const productionCompliance = require("./productionCompliance");
const logisticsManagers = require("./logisticsManagers");

dayjs.extend(utc);
dayjs.extend(timezone);

const list = (v, fallback) => (v ? String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : fallback);

// Les 5 matières de la « DEMANDE DE MATIÈRES PREMIÈRES », dans cet ordre —
// c'est aussi l'ordre des lignes de la popup.
const MATERIALS = Object.freeze(
  [
    { code: "ISO", label: "ISO" },
    { code: "RESINE", label: "RESINE" },
    { code: "ACCELERATEUR", label: "ACCELERATEUR" },
    { code: "GRAIN_PLASTIQUE", label: "GRAIN PLASTIQUE" },
    { code: "FIBRE", label: "FIBRE" },
  ].map(Object.freeze)
);
const UNIT = "KG";
const MODULES = Object.freeze(["promesh", "probar", "melange"]);

// ── Traçabilité et validation ─────────────────────────────────────────────
// Une demande est faite le VENDREDI (poste Matin) puis validée ou rejetée par
// le responsable logistique achats (validateurs nominatifs ci-dessous) avant
// le vendredi 14 h. Aucune validation automatique : passé l'échéance, la
// demande reste « En attente de validation » et est signalée en retard.
const STATUSES = Object.freeze({
  DRAFT: "DRAFT", // Brouillon
  PENDING_VALIDATION: "PENDING_VALIDATION", // En attente de validation (statut initial)
  SUBMITTED: "SUBMITTED", // Soumise (demandes antérieures à la validation obligatoire)
  VALIDATED: "VALIDATED", // Validée
  REJECTED: "REJECTED", // Rejetée
  IN_PROGRESS: "IN_PROGRESS", // En cours de traitement
  PROCESSED: "PROCESSED", // Traitée
  // Shift soir : prise en charge d'une demande VALIDÉE (quantités réelles
  // saisies) ou refus motivé. Ne remplace jamais la validation logistique
  // (validatedAt / validatedBy conservés).
  EVENING_ACCEPTED: "EVENING_ACCEPTED", // Acceptée par le shift soir
  EVENING_REFUSED: "EVENING_REFUSED", // Refusée par le shift soir
});

// Transitions autorisées. En attente → Validée / Rejetée : validateurs
// uniquement (isValidator) ; Rejetée → En attente : correction et nouvelle
// soumission par le demandeur (resubmit) ; Traitée est définitive.
const TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(["PENDING_VALIDATION"]),
  PENDING_VALIDATION: Object.freeze(["VALIDATED", "REJECTED"]),
  SUBMITTED: Object.freeze(["VALIDATED", "REJECTED", "IN_PROGRESS"]),
  VALIDATED: Object.freeze(["IN_PROGRESS", "PROCESSED", "REJECTED"]),
  IN_PROGRESS: Object.freeze(["PROCESSED", "REJECTED"]),
  REJECTED: Object.freeze([]),
  PROCESSED: Object.freeze([]),
  // Validée → Acceptée / Refusée par le shift soir : routes dédiées
  // (eveningAccept / eveningRefuse), jamais par le changement de statut
  // générique. Une demande acceptée peut ensuite être marquée Traitée.
  EVENING_ACCEPTED: Object.freeze(["PROCESSED"]),
  EVENING_REFUSED: Object.freeze([]),
});

// Une demande brouillon ou rejetée ne compte pas comme « soumise » pour le
// vendredi : la popup réapparaît et la création de fiche reste bloquée.
const INACTIVE_STATUSES = Object.freeze(["DRAFT", "REJECTED"]);

// Demandes « à traiter » par le responsable : soumises et sans décision.
// SUBMITTED = demandes créées avant la validation obligatoire (26/10/2026),
// jamais validées ni rejetées — elles attendent aussi une décision.
const AWAITING_DECISION_STATUSES = Object.freeze(["PENDING_VALIDATION", "SUBMITTED"]);

// Statuts visibles par le shift soir : la demande validée à prendre en
// charge, et celles qu'il a déjà acceptées / refusées (traçabilité).
const EVENING_VISIBLE_STATUSES = Object.freeze(["VALIDATED", "EVENING_ACCEPTED", "EVENING_REFUSED", "PROCESSED"]);

// Rôles qui voient toutes les demandes et gèrent les statuts de traitement,
// en plus des gestionnaires nominatifs (RAW_MATERIAL_REQUEST_MANAGERS).
const MANAGER_ROLES = Object.freeze(["admin", "superadmin", "superadmin2"]);

const TZ = "Africa/Tunis";

module.exports = {
  MATERIALS,
  UNIT,
  MODULES,
  STATUSES,
  TRANSITIONS,
  INACTIVE_STATUSES,
  AWAITING_DECISION_STATUSES,
  EVENING_VISIBLE_STATUSES,
  MANAGER_ROLES,
  TZ,

  // Horloge du serveur (remplaçable dans les tests) : le jour et l'heure
  // ne viennent jamais du navigateur.
  clock: () => new Date(),

  // Jour ISO de la demande (5 = vendredi) et échéance de validation (HH:mm, heure de Tunis).
  get requestDay() {
    return Number(process.env.RAW_MATERIAL_REQUEST_DAY || 5);
  },
  get deadlineTime() {
    return process.env.RAW_MATERIAL_REQUEST_DEADLINE || "14:00";
  },
  // « Échéance proche » : moins de N minutes avant l'échéance.
  get dueSoonMinutes() {
    return Number(process.env.RAW_MATERIAL_REQUEST_DUE_SOON_MINUTES || 120);
  },

  /** Jour de la demande en heure de Tunis : date, échéance et état à `now`. */
  dayContext(now = this.clock()) {
    const local = dayjs(now).tz(TZ);
    const date = local.format("YYYY-MM-DD");
    const deadlineAt = dayjs.tz(`${date} ${this.deadlineTime}`, "YYYY-MM-DD HH:mm", TZ).toDate();
    const isoDay = local.day() === 0 ? 7 : local.day();
    return {
      date,
      isRequestDay: isoDay === this.requestDay,
      deadlineAt,
      deadlinePassed: now.getTime() >= deadlineAt.getTime(),
    };
  },

  // Par email, comme les autres exceptions Production : le rôle
  // responsable_logistique_achat est partagé avec production_1..5.
  get managers() {
    // Responsables logistique et production (config/logisticsManagers.js).
    return list(process.env.RAW_MATERIAL_REQUEST_MANAGERS, logisticsManagers.emails);
  },

  // Shift soir : seuls comptes autorisés à saisir les quantités réelles et à
  // accepter / refuser une demande validée (vérifié en base le 29/10/2026 :
  // production_2@cbi-tunisia.com, rôle responsable_logistique_achat, horaires
  // PROD 2 14 h–22 h). Par email — le rôle est partagé avec production_1..5.
  get eveningHandlers() {
    return list(process.env.RAW_MATERIAL_REQUEST_EVENING_HANDLERS, ["production_2@cbi-tunisia.com"]);
  },

  isEveningHandler(user) {
    return !!user && this.eveningHandlers.includes(String(user.email || "").trim().toLowerCase());
  },

  // Seuls comptes autorisés à VALIDER / REJETER une demande en attente : le
  // responsable logistique achats, par email (vérifié en base le 28/10/2026 :
  // responsable_logistique@cbi-tunisia.com, rôle responsable_logistique_achat).
  // Jamais par rôle — production_1..5 partagent ce rôle.
  get validators() {
    return list(process.env.RAW_MATERIAL_REQUEST_VALIDATORS, logisticsManagers.emails);
  },

  /** Voit toutes les demandes et peut gérer les statuts de traitement. */
  isManager(user) {
    if (!user) return false;
    return (
      MANAGER_ROLES.includes(user.role) ||
      this.managers.includes(String(user.email || "").trim().toLowerCase()) ||
      this.isValidator(user)
    );
  },

  /** Peut valider ou rejeter une demande en attente (jamais la sienne, voir le service). */
  isValidator(user) {
    return !!user && this.validators.includes(String(user.email || "").trim().toLowerCase());
  },

  // RAW_MATERIAL_REQUEST_ENABLED=false désactive la popup ET le contrôle backend.
  get enabled() {
    return process.env.RAW_MATERIAL_REQUEST_ENABLED !== "false";
  },
  get requiredEmails() {
    return list(process.env.RAW_MATERIAL_REQUEST_EMAILS, ["production_1@cbi-tunisia.com"]);
  },
  get requiredPostes() {
    return list(process.env.RAW_MATERIAL_REQUEST_POSTES, ["matin"]);
  },

  /**
   * Poste de travail d'un compte au moment de la connexion, d'après les
   * horaires PROD 1 / PROD 2 existants (config/productionCompliance.js) :
   * début avant midi → "matin", sinon "nuit" (affiché « Soir »). null si
   * le compte n'a pas d'horaire de production.
   */
  sessionPosteFor(email) {
    const e = String(email || "").trim().toLowerCase();
    const prod = Object.values(productionCompliance.productions).find((p) => p.email === e);
    if (!prod) return null;
    return prod.start < "12:00" ? "matin" : "nuit";
  },

  /**
   * true si `email` doit faire la demande du jour au poste `poste` — à la
   * connexion (module null) ou avant de créer une fiche `module`. Uniquement
   * le jour de la demande (vendredi, heure du serveur).
   */
  isRequiredFor({ email, poste, module = null, now = this.clock() }) {
    if (!this.enabled) return false;
    if (module !== null && !MODULES.includes(String(module).toLowerCase())) return false;
    if (!this.requiredPostes.includes(String(poste || "").trim().toLowerCase())) return false;
    if (!this.requiredEmails.includes(String(email || "").trim().toLowerCase())) return false;
    return this.dayContext(now).isRequestDay;
  },
};
