"use strict";

/**
 * Crée le compte du module CONTRÔLE QUALITÉ :
 *   controle_qualite@cbi-tunisia.com — rôle "controle_qualite"
 * (voir migration 20260925090000-add-controle-qualite-to-users-role-enum.js).
 *
 * Accès piloté uniquement par le rôle (backend : moduleAccessGuard.js +
 * requireRole sur /quality-control et /production-records ; frontend :
 * sidebar/routing basés sur AuthService().userRole) — jamais admin/superadmin.
 *
 * Idempotent — un compte déjà existant est laissé INTACT (même règle que
 * production-accounts.seeder.js : jamais écraser un rôle existant).
 *
 * Usage:
 *   npx sequelize-cli db:seed --seed src/seeders/controle-qualite.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const EMAIL = "controle_qualite@cbi-tunisia.com";
const PASSWORD = "ChangeMe123!";
const ROLE = "controle_qualite";

module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(`SELECT id, role FROM users WHERE email = :email LIMIT 1`, {
      replacements: { email: EMAIL },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    });
    if (existing) {
      console.log(`      ~ User "${EMAIL}" already exists (role=${existing.role}) — skipped, jamais écrasé`);
      return;
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(PASSWORD, 12);
    const now = new Date();

    await queryInterface.sequelize.query(
      `INSERT INTO users (id, email, "passwordHash", "isActive", role, "createdAt", "updatedAt")
       VALUES (:id, :email, :passwordHash, true, :role, :now, :now)`,
      { replacements: { id: userId, email: EMAIL, passwordHash, role: ROLE, now } }
    );

    await queryInterface.sequelize.query(
      `INSERT INTO user_profiles (id, "userId", "createdAt", "updatedAt")
       VALUES (:profileId, :userId, :now, :now)`,
      { replacements: { profileId: uuidv4(), userId, now } }
    );

    console.log(`      + User "${EMAIL}" created with role ${ROLE}`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DELETE FROM users WHERE email = :email`, {
      replacements: { email: EMAIL },
    });
  },
};
