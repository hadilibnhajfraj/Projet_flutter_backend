"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const projectsTable = await queryInterface.describeTable("projects", { transaction });

      if (!projectsTable.engineerId) {
        await queryInterface.addColumn(
          "projects",
          "engineerId",
          {
            type: Sequelize.UUID,
            allowNull: true,
            references: {
              model: "engineers",
              key: "id",
            },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
          },
          { transaction }
        );
      }

      if (!projectsTable.architectId) {
        await queryInterface.addColumn(
          "projects",
          "architectId",
          {
            type: Sequelize.UUID,
            allowNull: true,
            references: {
              model: "architects",
              key: "id",
            },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
          },
          { transaction }
        );
      }

      await queryInterface.sequelize.query(
        'CREATE INDEX IF NOT EXISTS projects_engineer_id_idx ON "projects" ("engineerId")',
        { transaction }
      );

      await queryInterface.sequelize.query(
        'CREATE INDEX IF NOT EXISTS projects_architect_id_idx ON "projects" ("architectId")',
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex("projects", "projects_engineer_id_idx", { transaction });
      await queryInterface.removeIndex("projects", "projects_architect_id_idx", { transaction });
      await queryInterface.removeColumn("projects", "engineerId", { transaction });
      await queryInterface.removeColumn("projects", "architectId", { transaction });
    });
  },
};
