"use strict";

// Adds "Annulé" to the enum_project_actions_statut PostgreSQL ENUM type.
//
// ALTER TYPE … ADD VALUE cannot be executed inside a transaction on PostgreSQL
// < 12. Sequelize wraps migrations in a transaction by default, so we disable
// it here. On PostgreSQL 12+ the restriction is lifted, but keeping it outside
// a transaction is safe on all versions and avoids the runtime error.
//
// NOTE: PostgreSQL does not support removing ENUM values. There is no safe
// down() that restores the original type without data loss. The down()
// migration below is intentionally a no-op — run it only in development where
// you can recreate the DB from scratch if needed.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_project_actions_statut" ADD VALUE IF NOT EXISTS 'Annulé'`
    );
  },

  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
    // To fully revert in development, drop and recreate the column:
    //   ALTER TABLE project_actions ALTER COLUMN statut TYPE VARCHAR(50);
    //   DROP TYPE "enum_project_actions_statut";
    //   ALTER TABLE project_actions ALTER COLUMN statut TYPE
    //     "enum_project_actions_statut" USING statut::text::"enum_project_actions_statut";
  },
};
