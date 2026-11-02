"use strict";

// Notes de calcul : nom et type de chaque document (facultatifs). Purement
// additif — deux colonnes nullable, aucune donnée existante modifiée.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("calculation_note_documents", "title", { type: Sequelize.STRING(255), allowNull: true });
    // note_de_calcul | plan | hypotheses | metre | rapport | annexe | autre
    await queryInterface.addColumn("calculation_note_documents", "documentType", { type: Sequelize.STRING(40), allowNull: true });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("calculation_note_documents", "documentType");
    await queryInterface.removeColumn("calculation_note_documents", "title");
  },
};
