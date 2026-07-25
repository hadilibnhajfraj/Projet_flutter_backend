"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("por_promesh_non_conformites", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },

      porPromeshId: { type: Sequelize.UUID, allowNull: false },

      typeNC: { type: Sequelize.STRING(255), allowNull: true },
      gravite: { type: Sequelize.ENUM("faible", "moyenne", "critique"), allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      photoUrl: { type: Sequelize.STRING(500), allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("por_promesh_non_conformites", ["porPromeshId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("por_promesh_non_conformites");
  },
};
