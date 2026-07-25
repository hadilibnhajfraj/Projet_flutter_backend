"use strict";

// La fiche POR PROMESH opérateur a été simplifiée à une seule mesure
// (productionM2, en m²) — ces 6 colonnes ne sont plus écrites par aucun
// écran ni service et peuvent être supprimées définitivement.
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn("por_promesh", "longueur");
    await queryInterface.removeColumn("por_promesh", "largeur");
    await queryInterface.removeColumn("por_promesh", "quantiteGrainPlastique");
    await queryInterface.removeColumn("por_promesh", "quantitePromesh1");
    await queryInterface.removeColumn("por_promesh", "quantitePromesh2");
    await queryInterface.removeColumn("por_promesh", "quantitePromesh3");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "longueur", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addColumn("por_promesh", "largeur", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addColumn("por_promesh", "quantiteGrainPlastique", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addColumn("por_promesh", "quantitePromesh1", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addColumn("por_promesh", "quantitePromesh2", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addColumn("por_promesh", "quantitePromesh3", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
  },
};
