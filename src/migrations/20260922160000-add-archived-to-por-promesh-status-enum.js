"use strict";

// Ajoute "ARCHIVED" au type ENUM Postgres enum_por_promesh_status (BROUILLON,
// VALIDE existants, jamais retirés). Nécessaire pour le nouveau statut
// "fiche brouillon archivée automatiquement après 2h sans finalisation".
//
// ALTER TYPE … ADD VALUE ne peut pas s'exécuter dans une transaction sur les
// versions de PostgreSQL < 12. Sequelize enveloppe les migrations dans une
// transaction par défaut — désactivée ici, même approche que
// 20260713105217-add-superadmin2-to-users-role-enum.js.
//
// PostgreSQL ne permet pas de supprimer une valeur d'ENUM : down() est un
// no-op volontaire (à n'exécuter qu'en développement, en recréant la base
// si nécessaire).

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_por_promesh_status" ADD VALUE IF NOT EXISTS 'ARCHIVED'`);
  },
  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
