"use strict";

// Lecture automatique du Bon de Livraison (OCR) — la fiche Customer Shipment
// doit afficher de vraies données extraites du document. `reference`
// (colonne déjà existante, unique) continue de servir de clé interne : la
// valeur OCR du "Numéro" du BL l'alimente quand elle est fiable, sinon le
// générateur SHIP-{année}-NNNNNN existant prend le relais (même logique que
// pour les factures). `customerReference` est un NOUVEAU champ distinct —
// la "Référence" secondaire propre au document (ex. référence client),
// jamais confondue avec `reference` (notre clé). Instantané client/livraison
// jamais lié en dur à `clients` (nom/adresse/téléphone lus sur le document,
// pas un id résolu).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("finance_shipments", "customerReference", { type: Sequelize.STRING(150), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "customerName", { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "customerTaxId", { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "customerAddress", { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn("finance_shipments", "customerGovernorate", { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "customerHeadOfficeAddress", { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn("finance_shipments", "customerPhone", { type: Sequelize.STRING(50), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "truckRegistration", { type: Sequelize.STRING(50), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "truckManufacturer", { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "driverName", { type: Sequelize.STRING(150), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "deliveryAddress", { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn("finance_shipments", "ocrConfidence", { type: Sequelize.DECIMAL(5, 2), allowNull: true });
    await queryInterface.addColumn("finance_shipments", "ocrExtraction", { type: Sequelize.JSONB, allowNull: true });

    await queryInterface.sequelize.query(`ALTER TYPE "enum_finance_shipments_status" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW'`);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_shipments", "customerReference");
    await queryInterface.removeColumn("finance_shipments", "customerName");
    await queryInterface.removeColumn("finance_shipments", "customerTaxId");
    await queryInterface.removeColumn("finance_shipments", "customerAddress");
    await queryInterface.removeColumn("finance_shipments", "customerGovernorate");
    await queryInterface.removeColumn("finance_shipments", "customerHeadOfficeAddress");
    await queryInterface.removeColumn("finance_shipments", "customerPhone");
    await queryInterface.removeColumn("finance_shipments", "truckRegistration");
    await queryInterface.removeColumn("finance_shipments", "truckManufacturer");
    await queryInterface.removeColumn("finance_shipments", "driverName");
    await queryInterface.removeColumn("finance_shipments", "deliveryAddress");
    await queryInterface.removeColumn("finance_shipments", "ocrConfidence");
    await queryInterface.removeColumn("finance_shipments", "ocrExtraction");
  },
};
