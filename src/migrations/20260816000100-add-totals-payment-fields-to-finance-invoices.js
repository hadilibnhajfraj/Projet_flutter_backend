"use strict";

// "CORRIGER L'EXTRACTION DES FACTURES + REGISTER PAYMENT" : le bloc bas de
// facture (Acompte/NET A PAYER/Conditions de règlement/Montant en lettres)
// n'avait aucune colonne dédiée — toutes nullable, jamais une valeur
// inventée si absente du document.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("finance_invoices", "downPayment", { type: Sequelize.DECIMAL(14, 2), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "netToPay", { type: Sequelize.DECIMAL(14, 2), allowNull: true });
    // Condition de règlement lue telle quelle sur le document (ex. "le
    // 23/07/26") — distincte de `paymentDate` (normalisée) et de la date de
    // facture/livraison.
    await queryInterface.addColumn("finance_invoices", "paymentCondition", { type: Sequelize.STRING(150), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "paymentDate", { type: Sequelize.DATEONLY, allowNull: true });
    // Mode de règlement IMPRIMÉ SUR LE DOCUMENT (Traite/Chèque/...) —
    // distinct du mode choisi par l'utilisateur à l'enregistrement d'un
    // paiement réel (voir FinancePayment.paymentMethod).
    await queryInterface.addColumn("finance_invoices", "paymentMethod", { type: Sequelize.STRING(50), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "amountInWords", { type: Sequelize.TEXT, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_invoices", "downPayment");
    await queryInterface.removeColumn("finance_invoices", "netToPay");
    await queryInterface.removeColumn("finance_invoices", "paymentCondition");
    await queryInterface.removeColumn("finance_invoices", "paymentDate");
    await queryInterface.removeColumn("finance_invoices", "paymentMethod");
    await queryInterface.removeColumn("finance_invoices", "amountInWords");
  },
};
