"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("por_promesh_process_control", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      porPromeshId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "por_promesh", key: "id" },
        onDelete: "CASCADE",
      },
      categorie: { type: Sequelize.STRING(50), allowNull: false },
      parametre: { type: Sequelize.STRING(255), allowNull: true },
      valeurP1: { type: Sequelize.STRING(50), allowNull: true },
      valeurP2: { type: Sequelize.STRING(50), allowNull: true },
      conforme: { type: Sequelize.BOOLEAN, allowNull: true },
      observation: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("por_promesh_process_control", ["porPromeshId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("por_promesh_process_control");
  },
};
