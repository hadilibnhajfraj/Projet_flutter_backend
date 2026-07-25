"use strict";

// Adds "traitee" to the enum_hr_requests_statut PostgreSQL ENUM type —
// nouveau statut final après "acceptee" (dossier finalisé/classé par le
// Responsable RH). ALTER TYPE … ADD VALUE ne peut pas s'exécuter dans une
// transaction — même technique que les migrations d'ENUM précédentes.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_hr_requests_statut" ADD VALUE IF NOT EXISTS 'traitee'`
    );
  },
  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
