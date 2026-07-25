"use strict";

/**
 * Guarantees that cbitunisia@cbi-tunisia.com is a superadmin, without any
 * restriction. Idempotent — upserts the role/isActive on an existing
 * account, or creates one with a temporary password if it doesn't exist yet.
 *
 * Usage:
 *   npx sequelize-cli db:seed --seed src/seeders/superadmin-cbi.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const EMAIL = "cbitunisia@cbi-tunisia.com";
const TEMP_PASSWORD = "ChangeMe123!";
const ROLE = "superadmin";

module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      `SELECT id, role FROM users WHERE email = :email LIMIT 1`,
      { replacements: { email: EMAIL }, type: "SELECT" }
    );

    if (existing) {
      if (existing.role === ROLE) {
        console.log(`      ~ User "${EMAIL}" already superadmin — skipped`);
        return;
      }
      await queryInterface.sequelize.query(
        `UPDATE users SET role = :role, "isActive" = true, "updatedAt" = :now WHERE id = :id`,
        { replacements: { role: ROLE, now: new Date(), id: existing.id } }
      );
      console.log(`      ~ User "${EMAIL}" promoted to ${ROLE}`);
      return;
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(TEMP_PASSWORD, 12);
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

    console.log(`      + User "${EMAIL}" created with role ${ROLE} (temp password: ${TEMP_PASSWORD})`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE users SET role = 'user' WHERE email = :email`,
      { replacements: { email: EMAIL } }
    );
  },
};
