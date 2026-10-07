"use strict";

// Module CONTRÔLE QUALITÉ — deux champs saisis par le contrôleur dans les
// informations générales de la fiche :
// - quality_controls.lot : numéro / code du lot ;
// - quality_controls."manufacturingOrder" : ordre de fabrication.
//
// Additive et réversible : colonnes nullables, aucune donnée existante
// modifiée (les fiches existantes restent sans lot ni ordre de fabrication).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn("quality_controls", "lot", { type: Sequelize.STRING(100), allowNull: true }, { transaction });
      await queryInterface.addColumn("quality_controls", "manufacturingOrder", { type: Sequelize.STRING(100), allowNull: true }, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn("quality_controls", "manufacturingOrder", { transaction });
      await queryInterface.removeColumn("quality_controls", "lot", { transaction });
    });
  },
};
