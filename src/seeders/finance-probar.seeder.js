"use strict";

/**
 * Seeds the default finance_probar user for the Finance module.
 * Idempotent — skips if the email already exists.
 *
 * Usage:
 *   npx sequelize-cli db:seed --seed src/seeders/finance-probar.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const EMAIL = "financeprobar@cbi-tunisia.com";
const PASSWORD = "ChangeMe123!";
const ROLE = "finance_probar";
const DISPLAY_NAME = "Finance PROBAR";

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
