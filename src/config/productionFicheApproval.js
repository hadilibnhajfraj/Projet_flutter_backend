"use strict";

// Validation obligatoire des NOUVELLES fiches de production (PROMESH et
// PROBAR) créées par les comptes de production listés ici — par défaut
// production_1 (poste Matin) et production_2 (poste Soir) — par le
// responsable logistique (validateurs ci-dessous).
//
// Règle nominative (par email) et non par rôle : production_1..5 et
// responsable_logistique partagent le rôle `responsable_logistique_achat`
// (même principe que config/rawMaterialRequest.js).
//
// Ce statut de validation est DISTINCT du cycle de saisie existant
// (PROMESH BROUILLON → VALIDE, PROBAR enregistree → validee) qui reste
// inchangé : « Terminer la saisie » ou le verrouillage automatique à 24 h ne
// valent jamais validation par le responsable. Les fiches antérieures
// (approvalStatus NULL) ne sont pas concernées.

const logisticsManagers = require("./logisticsManagers");
const list = (v, fallback) => (v ? String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : fallback);

const STATUSES = Object.freeze({
  PENDING: "PENDING", // En attente de validation
  APPROVED: "APPROVED", // Validée
  REJECTED: "REJECTED", // Refusée
});

const STATUS_LABELS = Object.freeze({
  PENDING: "En attente de validation",
  APPROVED: "Validée",
  REJECTED: "Refusée",
});

// Types de fiche concernés : PROMESH (table por_promesh) et PROBAR
// (industrial_records, module probar).
const FICHE_TYPES = Object.freeze(["promesh", "probar"]);

// Consultation en lecture seule de toutes les fiches soumises à validation.
const VIEWER_ROLES = Object.freeze(["admin", "superadmin", "superadmin2"]);

const norm = (email) => String(email || "").toLowerCase().trim();

module.exports = {
  STATUSES,
  STATUS_LABELS,
  FICHE_TYPES,
  VIEWER_ROLES,
  get creators() {
    return list(process.env.FICHE_APPROVAL_CREATORS, ["production_1@cbi-tunisia.com", "production_2@cbi-tunisia.com"]);
  },
  get validators() {
    // Responsables logistique et production (config/logisticsManagers.js).
    return list(process.env.FICHE_APPROVAL_VALIDATORS, logisticsManagers.emails);
  },
  isCreator(email) {
    return this.creators.includes(norm(email));
  },
  isValidator(email) {
    return this.validators.includes(norm(email));
  },
  canViewAll(actor) {
    return this.isValidator(actor.email) || VIEWER_ROLES.includes(actor.role);
  },
};
