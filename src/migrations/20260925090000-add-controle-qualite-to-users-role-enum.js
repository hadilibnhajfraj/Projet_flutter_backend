"use strict";

// Adds "controle_qualite" to the enum_users_role PostgreSQL ENUM type — same
// approach as 20260824000100-add-finance-production-to-users-role-enum.js.
//
// Rôle dédié au module CONTRÔLE QUALITÉ (checklist de production) : accès en
// lecture seule aux fiches PROMESH/PROBAR (/production-records) + création/
// validation de ses propres contrôles (/quality-control) — jamais un accès
// admin/superadmin, jamais de modification des fiches de production.
//
// ALTER TYPE … ADD VALUE cannot be executed inside a transaction on PostgreSQL
// < 12, hence no explicit transaction wrapping here.
//
// NOTE: PostgreSQL does not support removing ENUM values, so down() is a
// no-op — run it only in development where you can recreate the DB if needed.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'controle_qualite'`
    );
  },

  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
