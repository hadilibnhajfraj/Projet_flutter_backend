"use strict";

// Adds "superadmin2" to the enum_users_role PostgreSQL ENUM type.
//
// ALTER TYPE … ADD VALUE cannot be executed inside a transaction on PostgreSQL
// < 12. Sequelize wraps migrations in a transaction by default, so we disable
// it here (same approach as 20260622090000-add-responsable-logistique-achat-to-users-role-enum.js).
//
// NOTE: PostgreSQL does not support removing ENUM values, so down() is a
// no-op — run it only in development where you can recreate the DB if needed.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'superadmin2'`
    );
  },
  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
