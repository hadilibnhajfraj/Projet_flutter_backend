"use strict";

/**
 * Crée le compte back-office en CONSULTATION SEULE backoffice@cbi-tunisia.com
 * (rôle backoffice_readonly — voir config/backofficeReadOnly.js et
 * middleware/readOnlyRoleGuard.js : visibilité du compte de référence
 * info@probardistribution.com, aucune écriture). Jamais de droits
 * administrateur.
 *
 * Idempotent : un compte déjà existant est laissé INTACT (ni rôle ni mot de
 * passe modifiés) — pour changer son mot de passe, utiliser la procédure
 * « mot de passe oublié » de l'application.
 *
 * Mot de passe initial : fourni dans la variable d'environnement
 * BACKOFFICE_PASSWORD (jamais écrit dans le code, jamais affiché), haché avec
 * bcrypt (coût 12) comme le reste de l'application. Au moins 8 caractères,
 * une majuscule, une minuscule, un chiffre et un caractère spécial.
 *
 * Prérequis : migration 20261102090000-add-backoffice-readonly-to-users-role-enum.
 *
 * Usage :
 *   BACKOFFICE_PASSWORD='…' npx sequelize-cli db:seed --seed backoffice-readonly.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const { isStrongPassword } = require("./responsable-production.seeder");

const EMAIL = "backoffice@cbi-tunisia.com";
const ROLE = "backoffice_readonly";

module.exports = {
  EMAIL,
  ROLE,

  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(`SELECT id FROM users WHERE lower(email) = :email LIMIT 1`, {
      replacements: { email: EMAIL },
      type: "SELECT",
    });
    if (existing) {
      console.log(`      ~ User "${EMAIL}" already exists — skipped (aucune modification)`);
      return;
    }

    const password = process.env.BACKOFFICE_PASSWORD;
    if (!isStrongPassword(password)) {
      throw new Error("BACKOFFICE_PASSWORD absent ou trop faible (8 caractères minimum, majuscule, minuscule, chiffre et caractère spécial).");
    }

    // Le rôle doit exister dans l'enum de la base (migration appliquée).
    const [{ ok }] = await queryInterface.sequelize.query(`SELECT :role = ANY (enum_range(NULL::"enum_users_role")::text[]) AS ok`, {
      replacements: { role: ROLE },
      type: "SELECT",
    });
    if (!ok) throw new Error(`Rôle ${ROLE} inconnu de la base : appliquer d'abord la migration 20261102090000.`);

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `INSERT INTO users (id, email, "passwordHash", "isActive", role, "createdAt", "updatedAt")
         VALUES (:id, :email, :passwordHash, true, :role, :now, :now)`,
        { replacements: { id: userId, email: EMAIL, passwordHash, role: ROLE, now }, transaction }
      );
      // Profil créé ici : GET /users/me/profile n'aura jamais à l'écrire.
      await queryInterface.sequelize.query(
        `INSERT INTO user_profiles (id, "userId", "createdAt", "updatedAt")
         VALUES (:profileId, :userId, :now, :now)`,
        { replacements: { profileId: uuidv4(), userId, now }, transaction }
      );
    });

    console.log(`      + User "${EMAIL}" created with role ${ROLE}`);
  },

  async down(queryInterface) {
    // Seulement ce compte (et son profil), jamais un autre.
    await queryInterface.sequelize.query(`DELETE FROM user_profiles WHERE "userId" IN (SELECT id FROM users WHERE email = :email)`, {
      replacements: { email: EMAIL },
    });
    await queryInterface.sequelize.query(`DELETE FROM users WHERE email = :email`, { replacements: { email: EMAIL } });
  },
};
