// models/FinancePurchaseOrderItem.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Ligne du Bon de Commande extraite par OCR (Référence/Désignation/Unité/
// Qté/PU.HT/Montant HT) — table dédiée, toutes colonnes nullable.
const FinancePurchaseOrderItem = sequelize.define(
  "FinancePurchaseOrderItem",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    purchaseOrderId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "finance_purchase_orders", key: "id" },
      onDelete: "CASCADE",
    },

    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    reference: { type: DataTypes.STRING(100), allowNull: true },
    designation: { type: DataTypes.TEXT, allowNull: true },
    unit: { type: DataTypes.STRING(50), allowNull: true },

    quantity: { type: DataTypes.DECIMAL(16, 4), allowNull: true },
    unitPriceHT: { type: DataTypes.DECIMAL(16, 4), allowNull: true },
    amountHT: { type: DataTypes.DECIMAL(14, 3), allowNull: true },
  },
  {
    tableName: "finance_purchase_order_items",
    timestamps: true,
    indexes: [{ fields: ["purchaseOrderId"] }],
  }
);

module.exports = FinancePurchaseOrderItem;
