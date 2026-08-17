// models/FinanceShipmentItem.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Ligne produit d'un Bon de Livraison extraite par OCR — voir migration
// 20260814000400-create-finance-shipment-items.js. Toutes colonnes
// nullable : ne jamais inventer une valeur absente du document.
const FinanceShipmentItem = sequelize.define(
  "FinanceShipmentItem",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    shipmentId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "finance_shipments", key: "id" },
      onDelete: "CASCADE",
    },

    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    reference: { type: DataTypes.STRING(100), allowNull: true },
    designation: { type: DataTypes.TEXT, allowNull: true },
    unit: { type: DataTypes.STRING(50), allowNull: true },
    diameter: { type: DataTypes.STRING(50), allowNull: true },
    meshSize: { type: DataTypes.STRING(50), allowNull: true },
    quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
  },
  {
    tableName: "finance_shipment_items",
    timestamps: true,
    indexes: [{ fields: ["shipmentId"] }],
  }
);

module.exports = FinanceShipmentItem;
