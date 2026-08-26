"use strict";

/**
 * §MODIFICATION — COMPTES PRODUCTION AVEC LE MÊME RÔLE QUE RESPONSABLE
 * LOGISTIQUE : crée les 5 comptes production_1..5@cbi-tunisia.com avec
 * EXACTEMENT le même rôle que responsable_logistique@cbi-tunisia.com
 * (voir responsable-logistique-achat.seeder.js) — "responsable_logistique_achat"
 * réutilisé tel quel, aucun nouveau rôle "Production" créé. Le système
 * étant entièrement pilité par le rôle (backend : moduleAccessGuard.js#
 * ALLOWED_PREFIXES_BY_ROLE ; frontend : sidebar/routing/dashboard basés sur
 * AuthService().userRole, jamais sur l'email), ce même rôle suffit à
 * garantir sidebar/dashboard/routes/permissions identiques — aucun autre
 * fichier n'a besoin d'être modifié.
 *
 * Idempotent — un compte déjà existant (peu importe son rôle actuel) est
 * laissé INTACT (voir §14 "ne pas casser l'existant" : ce script ne fait que
 * CRÉER les comptes manquants, jamais écraser un compte qui existerait déjà
 * sous un rôle différent sans confirmation explicite).
 *
 * Usage:
 *   npx sequelize-cli db:seed --seed src/seeders/production-accounts.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const PASSWORD = "ChangeMe123!";
const ROLE = "responsable_logistique_achat";
const EMAILS = [
  "production_1@cbi-tunisia.com",
  "production_2@cbi-tunisia.com",
  "production_3@cbi-tunisia.com",
  "production_4@cbi-tunisia.com",
  "production_5@cbi-tunisia.com",
];

module.exports = {
  async up(queryInterface) {
    const passwordHash = await bcrypt.hash(PASSWORD, 12);
    const now = new Date();

    for (const email of EMAILS) {
      const [existing] = await queryInterface.sequelize.query(`SELECT id, role FROM users WHERE email = :email LIMIT 1`, {
        replacements: { email },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      });
      if (existing) {
        console.log(`      ~ User "${email}" already exists (role=${existing.role}) — skipped, jamais écrasé`);
        continue;
      }

      const userId = uuidv4();
      await queryInterface.sequelize.query(
        `INSERT INTO users (id, email, "passwordHash", "isActive", role, "createdAt", "updatedAt")
         VALUES (:id, :email, :passwordHash, true, :role, :now, :now)`,
        { replacements: { id: userId, email, passwordHash, role: ROLE, now } }
      );

      await queryInterface.sequelize.query(
        `INSERT INTO user_profiles (id, "userId", "createdAt", "updatedAt")
         VALUES (:profileId, :userId, :now, :now)`,
        { replacements: { profileId: uuidv4(), userId, now } }
      );

      console.log(`      + User "${email}" created with role ${ROLE}`);
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DELETE FROM users WHERE email = ANY(ARRAY[:emails]::text[])`, {
      replacements: { emails: EMAILS },
    });
  },
};
