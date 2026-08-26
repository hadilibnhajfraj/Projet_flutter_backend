"use strict";

// Adds "finance_production" to the enum_users_role PostgreSQL ENUM type — same
// approach as 20260813000100-add-finance-probar-to-users-role-enum.js.
//
// §MODIFICATION — INTERFACE PRODUCTION DE DENNISREDFEATHER : ce rôle donne à
// dennisredfeather@gmail.com l'accès au module Production (POR PROMESH,
// PRODUCTION, MÉLANGE, MAINTENANCE — mêmes routes que
// responsable_logistique_achat) EN PLUS de son accès Finance existant
// (mêmes routes que finance_probar) — jamais un accès admin/superadmin.
//
// ALTER TYPE … ADD VALUE cannot be executed inside a transaction on PostgreSQL
// < 12, hence no explicit transaction wrapping here.
//
// NOTE: PostgreSQL does not support removing ENUM values, so down() is a
// no-op — run it only in development where you can recreate the DB if needed.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'finance_production'`
    );
  },

  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
