"use strict";

// Rôles NE POUVANT JAMAIS être sélectionnés comme "Commercial" dans le
// module Follow-up CRM (admin-tier + rôles techniques/opérationnels). Tout
// rôle NON listé ici est automatiquement éligible — aucune liste blanche à
// maintenir : un nouveau rôle commercial ajouté plus tard (ex.
// "responsable_commercial") est inclus sans modifier ce fichier.
const NON_COMMERCIAL_ROLES = [
  "admin",
  "superadmin",
  "superadmin2",
  "responsable_logistique_achat",
  "accueil", // accueil / réception — fonction non commerciale
];

function isCommercialEligibleRole(role) {
  return Boolean(role) && !NON_COMMERCIAL_ROLES.includes(role);
}

module.exports = { NON_COMMERCIAL_ROLES, isCommercialEligibleRole };
