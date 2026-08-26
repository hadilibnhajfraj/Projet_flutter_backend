"use strict";

/**
 * Seeds the Finance + Production Dashboard user for
 * dennisredfeather@gmail.com.
 *
 * Originally created with role "finance_probar" (§MODIFICATION — DASHBOARD
 * FINANCE PROFESSIONNEL POUR UN UTILISATEUR SPÉCIFIQUE). Role updated to
 * "finance_production" (§MODIFICATION — INTERFACE PRODUCTION DE
 * DENNISREDFEATHER, see migrations 20260824000100/200) — union of the
 * Finance scope (finance_probar) and the Production scope
 * (responsable_logistique_achat: por-promesh, industrial-records,
 * production-records, recuperables). ROLE below must stay in sync with
 * those migrations so a FRESH database (migrate + seed) ends up with the
 * same role as an existing one migrated forward — access control is
 * enforced backend-side (moduleAccessGuard + requireRole, see
 * finance.routes.js / porPromesh.routes.js / industrialRecord.routes.js /
 * productionRecords.routes.js), never by a frontend-only check.
 * Idempotent — skips if the email already exists.
 *
 * Usage:
 *   npx sequelize-cli db:seed --seed src/seeders/finance-dennis.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const EMAIL = "dennisredfeather@gmail.com";
const PASSWORD = "ChangeMe123!";
const ROLE = "finance_production";
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
