"use strict";

// "IDENTIFICATION DES DIFFÉRENTS PURCHASE ORDERS" : `orderNumber` est un
// champ OCR (nullable, non-unique, peut être absent du document) — il ne
// peut pas servir d'identifiant fiable pour distinguer les Purchase Orders
// dans Inflow Raw Materials. `poNumber` est un identifiant métier généré par
// l'application (jamais extrait/deviné), format "PO-00001", UNIQUE, un seul
// par Purchase Order — voir finance.service.js#generatePoNumber.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("finance_purchase_orders", "poNumber", {
      type: Sequelize.STRING(20),
      allowNull: true,
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_purchase_orders", "poNumber");
  },
};
