"use strict";

// Jeton du Super Admin réel (rôle superadmin + compte racine) — seul compte
// autorisé à supprimer une fiche de contrôle qualité. Le compte n'est jamais
// modifié : le jeton est simplement signé pour son id/email/rôle en base.
const User = require("../../src/models/User");
const { signAccessToken } = require("../../src/utils/tokens");
const { ROOT_ADMIN_EMAIL } = require("../../src/config/rootAdmin");

async function rootAdminToken() {
  const user = await User.findOne({ where: { email: ROOT_ADMIN_EMAIL } });
  if (!user) throw new Error(`Compte ${ROOT_ADMIN_EMAIL} introuvable en base de test`);
  return signAccessToken({ sub: user.id, email: user.email, role: user.role });
}

module.exports = { rootAdminToken };
