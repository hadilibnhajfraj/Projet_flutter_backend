// models/FinanceInvoiceItem.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Ligne de facture extraite par OCR — voir migration
// 20260814000200-create-finance-invoice-items.js pour le raisonnement
// (table dédiée, pas un JSONB, toutes colonnes nullable : ne jamais
// inventer une valeur absente du document).
const FinanceInvoiceItem = sequelize.define(
  "FinanceInvoiceItem",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    invoiceId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "finance_invoices", key: "id" },
      onDelete: "CASCADE",
    },

    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    reference: { type: DataTypes.STRING(100), allowNull: true },
    designation: { type: DataTypes.TEXT, allowNull: true },
    unit: { type: DataTypes.STRING(50), allowNull: true },
    diameter: { type: DataTypes.STRING(50), allowNull: true },
    meshSize: { type: DataTypes.STRING(50), allowNull: true },

    quantity: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    unitPriceHT: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    rms: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    amountHT: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    tax1: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    tax2: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
  },
  {
    tableName: "finance_invoice_items",
    timestamps: true,
    indexes: [{ fields: ["invoiceId"] }],
  }
);

module.exports = FinanceInvoiceItem;
