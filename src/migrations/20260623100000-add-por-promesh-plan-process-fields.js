"use strict";

// Étape 2 — "Plan de Process PROMESH" : ces colonnes existaient côté
// formulaire Flutter (bainResine, air, ...) mais n'avaient jamais été
// créées en base, donc toutes les valeurs saisies étaient silencieusement
// perdues à l'enregistrement.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "bainResine", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "air", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "niveauBainEau", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "temperatureEau", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "temperatureDemandee", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "etatPistons", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "fluideVisuel", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "etatDisqueCoupe", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "etatAtelier", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "zoneStockage", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "note", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "signatureChefEquipe", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("por_promesh", "signatureChefEquipe");
    await queryInterface.removeColumn("por_promesh", "note");
    await queryInterface.removeColumn("por_promesh", "zoneStockage");
    await queryInterface.removeColumn("por_promesh", "etatAtelier");
    await queryInterface.removeColumn("por_promesh", "etatDisqueCoupe");
    await queryInterface.removeColumn("por_promesh", "fluideVisuel");
    await queryInterface.removeColumn("por_promesh", "etatPistons");
    await queryInterface.removeColumn("por_promesh", "temperatureDemandee");
    await queryInterface.removeColumn("por_promesh", "temperatureEau");
    await queryInterface.removeColumn("por_promesh", "niveauBainEau");
    await queryInterface.removeColumn("por_promesh", "air");
    await queryInterface.removeColumn("por_promesh", "bainResine");
  },
};
