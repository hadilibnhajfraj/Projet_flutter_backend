"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes("recuperable_lignes")) return;

    await queryInterface.createTable("recuperable_lignes", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },

      ficheId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "recuperable_fiches", key: "id" },
        onDelete: "CASCADE",
      },

      ligne: { type: Sequelize.ENUM("L1", "L2", "L3", "L4"), allowNull: false },

      diametre: {
        type: Sequelize.ENUM("6 mm", "8 mm", "10 mm", "12 mm", "14 mm", "16 mm", "20 mm", "Autre"),
        allowNull: false,
      },
      diametreAutre: { type: Sequelize.STRING(50), allowNull: true },

      quantiteProduite: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      dechetKg: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      produitFini: { type: Sequelize.DECIMAL(10, 2), allowNull: false },

      observation: { type: Sequelize.TEXT, allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("recuperable_lignes", ["ficheId"]);
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes("recuperable_lignes")) return;
    await queryInterface.dropTable("recuperable_lignes");
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_recuperable_lignes_ligne";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_recuperable_lignes_diametre";');
  },
};
