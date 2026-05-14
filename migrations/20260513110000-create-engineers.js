"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const tables = await queryInterface.showAllTables({ transaction });
      const tableNames = tables.map((table) =>
        typeof table === "string" ? table : table.tableName
      );

      if (!tableNames.includes("engineers")) {
        await queryInterface.createTable(
          "engineers",
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
            phone: {
              type: Sequelize.STRING(30),
              allowNull: true,
            },
            email: {
              type: Sequelize.STRING(200),
              allowNull: true,
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
        'CREATE UNIQUE INDEX IF NOT EXISTS engineers_name_unique ON "engineers" ("name")',
        { transaction }
      );

      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS engineers_name_lower_trim_unique ON "engineers" (LOWER(TRIM("name")))',
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("engineers", { transaction });
    });
  },
};
