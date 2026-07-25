"use strict";

// Adds "en_cours" to the enum_maintenance_requests_statut PostgreSQL ENUM
// type — nouveau statut intermédiaire entre "acceptee" (technicien affecté)
// et "terminee".
//
// ALTER TYPE … ADD VALUE cannot run inside a transaction on PostgreSQL < 12,
// and Sequelize wraps migrations in a transaction by default — same approach
// as 20260713105217-add-superadmin2-to-users-role-enum.js.
//
// NOTE: PostgreSQL cannot remove ENUM values, so down() is a no-op.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_maintenance_requests_statut" ADD VALUE IF NOT EXISTS 'en_cours'`
    );
  },
  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
