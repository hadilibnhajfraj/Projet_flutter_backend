"use strict";

// "CORRECTION URGENTE — CUSTOMER SHIPMENTS OCR" : le bloc "Adresse Siège"
// contient parfois un code client (ex. "C1745741E") sur sa 1re ligne,
// distinct du matricule fiscal — voir
// deliveryNoteFieldExtraction.service.js#extractHeadOfficeBlock. Même
// convention que FinanceInvoice.customerCode (migration 20260814000600).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("finance_shipments", "customerCode", { type: Sequelize.STRING(100), allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_shipments", "customerCode");
  },
};
