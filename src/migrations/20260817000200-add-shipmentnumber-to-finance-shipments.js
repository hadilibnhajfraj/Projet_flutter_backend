"use strict";

// "MODIFICATION — CUSTOMER SHIPMENTS" : `reference` reste soit le numéro de
// bon de livraison LU sur le document (OCR, non garanti), soit un repli
// auto-généré SHIP-{année}-NNNNNN quand l'OCR est peu fiable — il ne peut
// donc pas servir d'identifiant interne stable et prévisible. `shipmentNumber`
// est un identifiant métier généré INCONDITIONNELLEMENT par l'application à
// chaque upload (jamais extrait/deviné), format "SH-00001", UNIQUE, un seul
// par Customer Shipment — voir finance.service.js#generateShipmentNumber.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("finance_shipments", "shipmentNumber", {
      type: Sequelize.STRING(20),
      allowNull: true,
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_shipments", "shipmentNumber");
  },
};
