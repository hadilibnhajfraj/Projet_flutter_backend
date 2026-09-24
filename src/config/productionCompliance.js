"use strict";

// Configuration du contrôle de conformité des fiches PROD 1 / PROD 2.
// Toutes les règles métier sont exprimées en heure de Tunisie (Africa/Tunis) ;
// UTC n'est jamais utilisé directement pour décider d'une date ou d'une plage.

const list = (v, fallback) =>
  (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : fallback);

const lower = (arr) => arr.map((s) => s.toLowerCase());

const managers = lower(
  list(process.env.PRODUCTION_COMPLIANCE_MANAGERS, ["hadil.ibnhajfraj@gmail.com", "manegerofficecbi@gmail.com"])
);
const alertRecipients = lower(list(process.env.PRODUCTION_COMPLIANCE_ALERT_RECIPIENTS, managers));
// Destinataires des demandes d'autorisation de régularisation (par défaut : les responsables).
const requestRecipients = lower(list(process.env.PRODUCTION_COMPLIANCE_REQUEST_RECIPIENTS, managers));

module.exports = {
  // Actif par défaut ; PRODUCTION_COMPLIANCE_ENABLED=false pour tout désactiver
  // (contrôle, blocage et alertes).
  get enabled() {
    return process.env.PRODUCTION_COMPLIANCE_ENABLED !== "false";
  },
  timezone: "Africa/Tunis",

  // Première date contrôlée : aucune date antérieure n'est jamais réputée
  // « manquante » (sinon l'historique entier bloquerait les utilisateurs).
  startDate: process.env.PRODUCTION_COMPLIANCE_START_DATE || "2026-09-22",

  // Le CRM ne contient ni calendrier de travail, ni jours fériés (aucune
  // table correspondante) : les règles sont donc configurables ici.
  // Jours ISO : 1 = lundi … 7 = dimanche.
  workingDays: list(process.env.PRODUCTION_WORKING_DAYS, ["1", "2", "3", "4", "5"]).map(Number),
  // Dates fériées / non travaillées (YYYY-MM-DD).
  nonWorkingDates: list(process.env.PRODUCTION_NON_WORKING_DATES, []),

  // Une fiche en brouillon compte comme « créée » (elle existe en base).
  countDrafts: process.env.PRODUCTION_COMPLIANCE_COUNT_DRAFTS !== "false",

  // Durée de validité d'une autorisation de rattrapage non utilisée.
  backfillTtlHours: Number(process.env.PRODUCTION_BACKFILL_TTL_HOURS || 48),

  productions: {
    PROD1: { key: "PROD1", label: "PROD 1", email: "production_1@cbi-tunisia.com", start: "08:00", end: "14:30" },
    PROD2: { key: "PROD2", label: "PROD 2", email: "production_2@cbi-tunisia.com", start: "14:00", end: "22:00" },
  },

  managers, // emails autorisés à accorder rattrapage / passage
  alertRecipients,
  requestRecipients,

  // Validité d'une demande non traitée (heures) et nombre maximal de renvois d'e-mail.
  requestTtlHours: Number(process.env.PRODUCTION_REQUEST_TTL_HOURS || 72),
  maxEmailRetries: Number(process.env.PRODUCTION_REQUEST_MAX_EMAIL_RETRIES || 5),
  // E-mail à l'utilisateur quand sa demande est traitée (notification CRM toujours créée).
  get userEmailNotifications() {
    return process.env.PRODUCTION_COMPLIANCE_USER_EMAILS !== "false";
  },

  crmBaseUrl: (process.env.CRM_BASE_URL || "https://www.crmprobar.com").replace(/\/+$/, ""),
};
