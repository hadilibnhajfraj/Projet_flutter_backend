"use strict";

// "REGISTER PAYMENT" : formulaire avec mode de règlement (Carte bancaire /
// Espèce / Chèque / Traite) — champs spécifiques Chèque/Traite, NULL pour
// les autres modes (jamais une valeur inventée). Le document justificatif
// (Chèque/Traite) réutilise le mécanisme FinanceDocument existant (module
// "PAYMENT", entityId = paiement) — même convention que les 3 autres
// modules Finance, pas de nouvelle colonne "documentId" FK.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("finance_payments", "chequeNumber", { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn("finance_payments", "bankName", { type: Sequelize.STRING(150), allowNull: true });
    await queryInterface.addColumn("finance_payments", "chequeDate", { type: Sequelize.DATEONLY, allowNull: true });
    await queryInterface.addColumn("finance_payments", "billOfExchangeNumber", { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn("finance_payments", "dueDate", { type: Sequelize.DATEONLY, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_payments", "chequeNumber");
    await queryInterface.removeColumn("finance_payments", "bankName");
    await queryInterface.removeColumn("finance_payments", "chequeDate");
    await queryInterface.removeColumn("finance_payments", "billOfExchangeNumber");
    await queryInterface.removeColumn("finance_payments", "dueDate");
  },
};
