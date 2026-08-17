"use strict";

// "Inflow of raw materials" — jusqu'ici un simple dépôt de fichier
// (FinanceDocument, entityId toujours null, aucune donnée extraite).
// "CORRECTION — EXTRACTION AUTOMATIQUE DES BONS DE COMMANDE" : le Bon de
// Commande uploadé doit désormais être LU (OCR/texte PDF) comme les autres
// modules Finance (Invoice/Shipment) — table dédiée pour les champs
// extraits, toutes colonnes nullable (jamais de valeur inventée).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_purchase_orders", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      orderNumber: { type: Sequelize.STRING(100), allowNull: true },
      orderDate: { type: Sequelize.DATEONLY, allowNull: true },
      customerId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "clients", key: "id" },
      },
      // Instantané client tel que LU sur le document (jamais un lien dur
      // vers `clients`) — même convention que FinanceInvoice/FinanceShipment.
      customerCode: { type: Sequelize.STRING(100), allowNull: true },
      customerName: { type: Sequelize.STRING(255), allowNull: true },
      customerAddress: { type: Sequelize.TEXT, allowNull: true },
      deliveryAddress: { type: Sequelize.TEXT, allowNull: true },
      // Dinar tunisien = 3 décimales (millimes) — précision du document
      // source ("26 292,000"), pas arrondie à 2 comme les autres montants
      // Finance déjà en place.
      totalHT: { type: Sequelize.DECIMAL(14, 3), allowNull: true },
      ocrConfidence: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      ocrExtraction: { type: Sequelize.JSONB, allowNull: true },
      status: {
        type: Sequelize.ENUM("EXTRACTED", "NEEDS_REVIEW", "OCR_FAILED"),
        allowNull: false,
        defaultValue: "NEEDS_REVIEW",
      },
      createdBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_purchase_orders", ["customerId"]);
    await queryInterface.addIndex("finance_purchase_orders", ["status"]);
    await queryInterface.addIndex("finance_purchase_orders", ["orderNumber"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_purchase_orders");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_finance_purchase_orders_status"`);
  },
};
