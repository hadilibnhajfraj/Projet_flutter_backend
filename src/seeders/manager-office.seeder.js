"use strict";

/**
 * Seeds the default manegerofficecbi@gmail.com user (Responsable RH — reçoit
 * et traite toutes les demandes RH). Idempotent — skips if the email already
 * exists. Même pattern que responsable-logistique-achat.seeder.js.
 *
 * Usage:
 *   npx sequelize-cli db:seed --seed src/seeders/manager-office.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const EMAIL = "manegerofficecbi@gmail.com";

const PASSWORD = "ChangeMe123!";
const ROLE = "user";

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
