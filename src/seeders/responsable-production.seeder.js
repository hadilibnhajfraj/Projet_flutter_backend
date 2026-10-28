"use strict";

/**
 * Crée le compte responsable_production@cbi-tunisia.com, avec EXACTEMENT le
 * même rôle que responsable_logistique@cbi-tunisia.com
 * (responsable_logistique_achat — voir responsable-logistique-achat.seeder.js).
 * Ses droits nominatifs (validation des fiches, matières premières, demandes
 * Production, maintenance) viennent de config/logisticsManagers.js. Jamais de
 * droits Super Admin.
 *
 * Idempotent : un compte déjà existant est laissé INTACT (ni rôle ni mot de
 * passe modifiés) — pour changer son mot de passe, utiliser la procédure
 * « mot de passe oublié » de l'application.
 *
 * Mot de passe initial : fourni par l'administrateur dans la variable
 * d'environnement RESPONSABLE_PRODUCTION_PASSWORD (jamais écrit dans le code,
 * jamais affiché), haché avec bcrypt comme le reste de l'application. Il doit
 * comporter au moins 8 caractères, une majuscule, une minuscule, un chiffre
 * et un caractère spécial.
 *
 * Usage :
 *   RESPONSABLE_PRODUCTION_PASSWORD='…' npx sequelize-cli db:seed --seed responsable-production.seeder.js
 */

const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");

const EMAIL = "responsable_production@cbi-tunisia.com";
const ROLE = "responsable_logistique_achat";

function isStrongPassword(pw) {
  return (
    typeof pw === "string" &&
    pw.length >= 8 &&
    pw.length <= 72 &&
    /[A-Z]/.test(pw) &&
    /[a-z]/.test(pw) &&
    /[0-9]/.test(pw) &&
    /[^A-Za-z0-9]/.test(pw)
  );
}

module.exports = {
  isStrongPassword,

  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(`SELECT id FROM users WHERE lower(email) = :email LIMIT 1`, {
      replacements: { email: EMAIL },
      type: "SELECT",
    });
    if (existing) {
      console.log(`      ~ User "${EMAIL}" already exists — skipped (aucune modification)`);
      return;
    }

    const password = process.env.RESPONSABLE_PRODUCTION_PASSWORD;
    if (!isStrongPassword(password)) {
      throw new Error(
        "RESPONSABLE_PRODUCTION_PASSWORD absent ou trop faible (8 caractères minimum, majuscule, minuscule, chiffre et caractère spécial)."
      );
    }

    // Le rôle doit exister dans l'enum de la base (jamais inventé).
    const [{ ok }] = await queryInterface.sequelize.query(
      `SELECT :role = ANY (enum_range(NULL::"enum_users_role")::text[]) AS ok`,
      { replacements: { role: ROLE }, type: "SELECT" }
    );
    if (!ok) throw new Error(`Rôle ${ROLE} inconnu de la base.`);

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `INSERT INTO users (id, email, "passwordHash", "isActive", role, "createdAt", "updatedAt")
         VALUES (:id, :email, :passwordHash, true, :role, :now, :now)`,
        { replacements: { id: userId, email: EMAIL, passwordHash, role: ROLE, now }, transaction }
      );
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
    await queryInterface.sequelize.query(
      `DELETE FROM user_profiles WHERE "userId" IN (SELECT id FROM users WHERE email = :email)`,
      { replacements: { email: EMAIL } }
    );
    await queryInterface.sequelize.query(`DELETE FROM users WHERE email = :email`, { replacements: { email: EMAIL } });
  },
};
