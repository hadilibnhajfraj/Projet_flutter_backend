"use strict";

// Adds a `priority` column to the projects table.
// Uses VARCHAR(20) instead of a PG ENUM so new values can be added without
// a table rewrite and the column can be added with IF NOT EXISTS (idempotent).

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'medium';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE projects DROP COLUMN IF EXISTS priority;
    `);
  },
};
