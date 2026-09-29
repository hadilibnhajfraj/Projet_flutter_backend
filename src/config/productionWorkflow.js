"use strict";

// Workflow des demandes PRODUCTION (autorisation de backfill + désarchivage)
// — permissions nominatives et notifications email.
//
// POURQUOI PAR EMAIL ET PAS PAR RÔLE : responsable_logistique@cbi-tunisia.com
// partage le rôle `responsable_logistique_achat` avec production_1..5
// (production-accounts.seeder.js). Accorder ces permissions au RÔLE
// permettrait à production_1 d'approuver ses propres demandes. Même principe
// que les autres exceptions nominatives déjà en place
// (PRODUCTION_COMPLIANCE_MANAGERS, PRODUCTION_SUMMARY_FULL_VISIBILITY_EMAILS).
//
// Les responsables Production Compliance existants (cfg.managers + rôles
// admin/superadmin/superadmin2, voir compliance.service#isComplianceManagerUser)
// conservent TOUS leurs droits actuels — ce fichier n'en retire aucun, il
// n'accorde des droits supplémentaires qu'aux comptes listés ci-dessous.

const PERMISSIONS = Object.freeze({
  AUTHORIZATION_VIEW: "production.authorization.view",
  AUTHORIZATION_APPROVE: "production.authorization.approve",
  AUTHORIZATION_REJECT: "production.authorization.reject",
  ARCHIVE_VIEW: "production.archive.view",
  ARCHIVE_APPROVE: "production.archive.approve",
  ARCHIVE_REJECT: "production.archive.reject",
  STATISTICS_VIEW: "production.statistics.view",
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

const list = (v, fallback) => (v ? String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : fallback);

// Comptes recevant les 7 permissions ci-dessus (et UNIQUEMENT celles-ci —
// jamais admin/RH/maintenance/finance, ni les autres écrans Production
// Compliance : contrôle journalier, autorisations directes, run-check...).
function permissionGrantsByEmail() {
  const emails = list(process.env.PRODUCTION_WORKFLOW_MANAGERS, ["responsable_logistique@cbi-tunisia.com"]);
  return new Map(emails.map((e) => [e, ALL_PERMISSIONS]));
}

function emailPermissions(email) {
  if (!email) return [];
  return permissionGrantsByEmail().get(String(email).trim().toLowerCase()) || [];
}

function hasEmailPermission(email, permission) {
  return emailPermissions(email).includes(permission);
}

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  emailPermissions,
  hasEmailPermission,

  // Destinataire(s) des emails "nouvelle demande Production" — adresse
  // interne dédiée à CE workflow uniquement, jamais dérivée des données
  // d'une demande (voir production-requests/services/notify.service.js).
  get notifyRecipients() {
    return list(process.env.PRODUCTION_WORKFLOW_NOTIFY_EMAILS, ["productioncbiftunisia@gmail.com"]);
  },
};
