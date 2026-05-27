"use strict";

// Drops the overly-restrictive unique index on (projectId, typeAction_legacy)
// that incorrectly prevented the same action type from being used more than once
// per project. In a CRM, multiple visits / calls on different dates are normal.
// Replaces it with a non-unique performance index on (projectId, dateAction).

module.exports = {
  async up(queryInterface) {
    // Drop the unique constraint
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS project_actions_unique_idx;
    `);

    // Add a normal (non-unique) composite index for timeline queries
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS project_actions_project_date_idx
      ON project_actions ("projectId", "dateAction" DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS project_actions_project_date_idx;
    `);

    // Restore the old unique index (will fail if duplicates exist)
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS project_actions_unique_idx
      ON project_actions ("projectId", "typeAction_legacy");
    `);
  },
};
