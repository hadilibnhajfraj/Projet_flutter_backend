module.exports = {
  async up(queryInterface, Sequelize) {

    // REMOVE DUPLICATES
    await queryInterface.sequelize.query(`
      DELETE FROM project_actions a
      USING project_actions b
      WHERE a.id::text > b.id::text
      AND a."projectId" = b."projectId"
      AND a."typeAction_legacy" = b."typeAction_legacy";
    `);

    // CREATE UNIQUE INDEX
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      project_actions_unique_idx
      ON project_actions (
        "projectId",
        "typeAction_legacy"
      );
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS project_actions_unique_idx;
    `);
  },
};