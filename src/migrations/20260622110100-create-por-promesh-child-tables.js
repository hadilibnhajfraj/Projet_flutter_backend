"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("por_promesh_controles_qualite", {
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
      heure: { type: Sequelize.TIME, allowNull: true },
      maille: { type: Sequelize.STRING(50), allowNull: true },
      longueur: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      largeur: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      statutCOQ: { type: Sequelize.ENUM("C", "NC"), allowNull: true },
      observation: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable("por_promesh_arrets_machine", {
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
      tArret: { type: Sequelize.STRING(255), allowNull: true },
      observationMachine: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable("por_promesh_consommations", {
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
      designationArticle: { type: Sequelize.STRING(255), allowNull: true },
      metrage: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      observation: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("por_promesh_controles_qualite", ["porPromeshId"]);
    await queryInterface.addIndex("por_promesh_arrets_machine", ["porPromeshId"]);
    await queryInterface.addIndex("por_promesh_consommations", ["porPromeshId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("por_promesh_consommations");
    await queryInterface.dropTable("por_promesh_arrets_machine");
    await queryInterface.dropTable("por_promesh_controles_qualite");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_por_promesh_controles_qualite_statutCOQ"`);
  },
};
