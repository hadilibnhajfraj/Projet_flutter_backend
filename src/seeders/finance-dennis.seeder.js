"use strict";

/**
 * Seeds the Finance Dashboard user for dennisredfeather@gmail.com
 * (§MODIFICATION — DASHBOARD FINANCE PROFESSIONNEL POUR UN UTILISATEUR
 * SPÉCIFIQUE). Reuses the EXISTING "finance_probar" role — access control is
 * enforced backend-side (moduleAccessGuard + requireRole, see
 * finance.routes.js), never by a frontend-only check. This role already
 * restricts the account to /finance, /api/clients, /auth, /users/me,
 * /uploads, /me — no admin/user-management/settings access (§15).
 * Idempotent — skips if the email already exists.
 *
 * Usage:
 *   npx sequelize-cli db:seed --seed src/seeders/finance-dennis.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const EMAIL = "dennisredfeather@gmail.com";
const PASSWORD = "ChangeMe123!";
const ROLE = "finance_probar";
const DISPLAY_NAME = "Dennis Redfeather";

module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      `SELECT id FROM users WHERE email = :email LIMIT 1`,
      { replacements: { email: EMAIL }, type: "SELECT" }
    );
    if (existing) {
      console.log(`      ~ User "${EMAIL}" already exists — skipped`);
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
      `INSERT INTO user_profiles (id, "userId", "name", "createdAt", "updatedAt")
       VALUES (:profileId, :userId, :name, :now, :now)`,
      { replacements: { profileId: uuidv4(), userId, name: DISPLAY_NAME, now } }
    );

    console.log(`      + User "${EMAIL}" created with role ${ROLE}`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DELETE FROM users WHERE email = :email`, {
      replacements: { email: EMAIL },
    });
  },
};
