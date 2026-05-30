"use strict";

// Converts notifications.type from PG ENUM to VARCHAR(80).
// Same pattern used for projects.statut — lets us add new notification types
// without a schema migration each time.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE notifications
        ALTER COLUMN type TYPE VARCHAR(80)
        USING type::text;
    `);
    await queryInterface.sequelize.query(`
      DROP TYPE IF EXISTS "enum_notifications_type";
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE "enum_notifications_type" AS ENUM(
        'PROJECT_COMMENT',
        'PROJECT_UPDATE',
        'FOLLOWUP',
        'FOLLOWUP_MISSING',
        'CONTACT_CREATED'
      );
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE notifications
        ALTER COLUMN type TYPE "enum_notifications_type"
        USING type::"enum_notifications_type";
    `);
  },
};
