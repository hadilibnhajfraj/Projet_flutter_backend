// models/FinanceInvoiceTax.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Ligne de taxe du bloc fiscal (Code/Base/Taux/Taxe) extraite par OCR —
// nombre de lignes DYNAMIQUE, jamais supposé à 2 ou 3 (voir
// invoiceFieldExtraction.service.js#extractTaxesFromWords). Toutes les
// colonnes restent nullable : une valeur absente du document reste `null`.
const FinanceInvoiceTax = sequelize.define(
  "FinanceInvoiceTax",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    invoiceId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "finance_invoices", key: "id" },
      onDelete: "CASCADE",
    },

    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    code: { type: DataTypes.STRING(20), allowNull: true },
    base: { type: DataTypes.DECIMAL(14, 3), allowNull: true },
    rate: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    amount: { type: DataTypes.DECIMAL(14, 3), allowNull: true },
  },
  {
    tableName: "finance_invoice_taxes",
    timestamps: true,
    indexes: [{ fields: ["invoiceId"] }],
  }
);

module.exports = FinanceInvoiceTax;
