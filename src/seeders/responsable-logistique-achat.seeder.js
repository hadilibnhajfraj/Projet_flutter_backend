"use strict";

/**
 * Seeds the default responsable_logistique_achat user for the POR PROMESH module.
 * Idempotent — skips if the email already exists.
 *
 * Usage:
 *   npx sequelize-cli db:seed --seed src/seeders/responsable-logistique-achat.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const EMAIL = "responsable_logistique@cbi-tunisia.com";
const PASSWORD = "ChangeMe123!";
const ROLE = "responsable_logistique_achat";

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







