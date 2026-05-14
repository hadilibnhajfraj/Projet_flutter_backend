"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const tables = await queryInterface.showAllTables({ transaction });
      const hasCompanies = tables
        .map((table) => (typeof table === "string" ? table : table.tableName))
        .includes("companies");

      if (!hasCompanies) {
        await queryInterface.createTable(
          "companies",
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.UUIDV4,
              allowNull: false,
              primaryKey: true,
            },
            name: {
              type: Sequelize.STRING(200),
              allowNull: false,
              unique: true,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.fn("NOW"),
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.fn("NOW"),
            },
          },
          { transaction }
        );
      }

      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS companies_name_unique ON "companies" ("name")',
        { transaction }
      );

      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS companies_name_lower_trim_unique ON "companies" (LOWER(TRIM("name")))',
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("companies", { transaction });
    });
  },
};
