"use strict";

// Lignes du Bon de Commande extraites par OCR (Référence/Désignation/
// Unité/Qté/PU.HT/Montant HT). Table dédiée (jamais un JSONB) — même
// raisonnement que finance_invoice_items. Toutes colonnes nullable.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_purchase_order_items", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      purchaseOrderId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "finance_purchase_orders", key: "id" },
        onDelete: "CASCADE",
      },
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      designation: { type: Sequelize.TEXT, allowNull: true },
      unit: { type: Sequelize.STRING(50), allowNull: true },
      // Précision jusqu'à 4 décimales sur le document source
      // ("20 000,0000") — jamais tronquée.
      quantity: { type: Sequelize.DECIMAL(16, 4), allowNull: true },
      unitPriceHT: { type: Sequelize.DECIMAL(16, 4), allowNull: true },
      amountHT: { type: Sequelize.DECIMAL(14, 3), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_purchase_order_items", ["purchaseOrderId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_purchase_order_items");
  },
};
