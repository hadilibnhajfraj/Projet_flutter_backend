"use strict";

// Adds "responsable_logistique_achat" to the enum_users_role PostgreSQL ENUM type.
//
// ALTER TYPE … ADD VALUE cannot be executed inside a transaction on PostgreSQL
// < 12. Sequelize wraps migrations in a transaction by default, so we disable
// it here (same approach as 20260526140000-add-annule-to-statut-enum.js).
//
// NOTE: PostgreSQL does not support removing ENUM values, so down() is a
// no-op — run it only in development where you can recreate the DB if needed.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'responsable_logistique_achat'`
    );
  },

  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
