"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const projectsTable = await queryInterface.describeTable("projects", { transaction });

      if (!projectsTable.companyId) {
        await queryInterface.addColumn(
          "projects",
          "companyId",
          {
            type: Sequelize.UUID,
            allowNull: true,
            references: {
              model: "companies",
              key: "id",
            },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
          },
          { transaction }
        );
      }

      await queryInterface.sequelize.query(
        'CREATE INDEX IF NOT EXISTS projects_company_id_idx ON "projects" ("companyId")',
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex("projects", "projects_company_id_idx", { transaction });
      await queryInterface.removeColumn("projects", "companyId", { transaction });
    });
  },
};
