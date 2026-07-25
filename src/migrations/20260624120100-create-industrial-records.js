"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("industrial_records", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },

      module: { type: Sequelize.ENUM("probar", "melange", "maintenance"), allowNull: false },

      machine: { type: Sequelize.STRING(50), allowNull: true },
      poste: { type: Sequelize.ENUM("matin", "nuit"), allowNull: true },
      dateFiche: { type: Sequelize.DATEONLY, allowNull: false },
      operateur: { type: Sequelize.STRING(255), allowNull: true },

      quantiteProduite: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      statutQualite: { type: Sequelize.ENUM("ok", "nok"), allowNull: true },

      typePanne: { type: Sequelize.STRING(255), allowNull: true },
      urgence: { type: Sequelize.ENUM("faible", "moyenne", "critique"), allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      observations: { type: Sequelize.TEXT, allowNull: true },

      statut: { type: Sequelize.STRING(50), allowNull: false, defaultValue: "enregistree" },

      createdBy: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("industrial_records", ["module"]);
    await queryInterface.addIndex("industrial_records", ["machine"]);
    await queryInterface.addIndex("industrial_records", ["dateFiche"]);
    await queryInterface.addIndex("industrial_records", ["createdBy"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("industrial_records");
  },
};
