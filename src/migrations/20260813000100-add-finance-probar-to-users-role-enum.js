"use strict";

// Adds "finance_probar" to the enum_users_role PostgreSQL ENUM type — same
// approach as 20260622090000-add-responsable-logistique-achat-to-users-role-enum.js.
//
// ALTER TYPE … ADD VALUE cannot be executed inside a transaction on PostgreSQL
// < 12, hence no explicit transaction wrapping here.
//
// NOTE: PostgreSQL does not support removing ENUM values, so down() is a
// no-op — run it only in development where you can recreate the DB if needed.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'finance_probar'`
    );
  },

  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
