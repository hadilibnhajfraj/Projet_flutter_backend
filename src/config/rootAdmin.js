"use strict";

// Compte unique autorisé à gérer les demandes d'archivage/désarchivage
// (section "Demandes" du menu Administration).
const ROOT_ADMIN_EMAIL = "cbitunisia@cbi-tunisia.com";

// Rôle que ce compte doit porter EN BASE (superadmin-cbi.seeder.js) : une
// adresse seule ne suffit jamais.
const ROOT_ADMIN_ROLES = Object.freeze(["superadmin"]);

/** Compte (relu en base) = root admin : adresse, rôle et compte actif. */
function isRootAdminUser(user) {
  return (
    !!user &&
    user.isActive !== false &&
    ROOT_ADMIN_ROLES.includes(user.role) &&
    String(user.email || "").trim().toLowerCase() === ROOT_ADMIN_EMAIL
  );
}

/**
 * Relit l'utilisateur authentifié EN BASE (par l'id du jeton, jamais par une
 * adresse envoyée par le client) et le renvoie s'il est le root admin.
 * Raccourci : aucune lecture si l'adresse du jeton n'est pas la bonne.
 */
async function loadRootAdmin(actor, transaction) {
  if (!actor?.id || String(actor.email || "").trim().toLowerCase() !== ROOT_ADMIN_EMAIL) return null;
  const User = require("../models/User");
  const user = await User.findByPk(actor.id, { attributes: ["id", "email", "role", "isActive"], transaction });
  return isRootAdminUser(user) ? user : null;
}

module.exports = { ROOT_ADMIN_EMAIL, ROOT_ADMIN_ROLES, isRootAdminUser, loadRootAdmin };
