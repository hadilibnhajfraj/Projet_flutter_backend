"use strict";

// Adds "backoffice_readonly" to the enum_users_role PostgreSQL ENUM type
// (compte back-office en consultation seule — voir config/backofficeReadOnly.js
// et middleware/readOnlyRoleGuard.js). Purement additif : aucune donnée
// existante n'est modifiée.
//
// Same approach as 20260713105217-add-superadmin2-to-users-role-enum.js.
// PostgreSQL does not support removing ENUM values, so down() is a no-op.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'backoffice_readonly'`);
  },
  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
