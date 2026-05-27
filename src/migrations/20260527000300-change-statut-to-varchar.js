"use strict";

// Converts projects.statut from a PG ENUM to VARCHAR(100).
// ENUMs require a table rewrite to add new values; VARCHAR is extensible and
// lets us support per-model status lists (project / revendeur / applicateur)
// without schema migrations every time the list changes.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE projects
        ALTER COLUMN statut TYPE VARCHAR(100)
        USING statut::text;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE projects
        ALTER COLUMN statut SET DEFAULT 'Identification';
    `);

    // Drop the now-unused PG ENUM type (safe: no other table references it)
    await queryInterface.sequelize.query(`
      DROP TYPE IF EXISTS "enum_projects_statut";
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE "enum_projects_statut" AS ENUM(
        'Identification',
        'Proposition technique',
        'Proposition commerciale',
        'Négociation',
        'Livraison',
        'Fidélisation'
      );
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE projects
        ALTER COLUMN statut TYPE "enum_projects_statut"
        USING statut::"enum_projects_statut";
    `);
  },
};
