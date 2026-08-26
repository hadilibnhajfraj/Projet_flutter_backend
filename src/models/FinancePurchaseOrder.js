// models/FinancePurchaseOrder.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// "Inflow of raw materials" — Bon de Commande lu automatiquement par OCR à
// l'upload (§CORRECTION — EXTRACTION AUTOMATIQUE DES BONS DE COMMANDE).
// Toutes les colonnes extraites restent nullable : une valeur absente du
// document reste `null`, jamais inventée.
const FinancePurchaseOrder = sequelize.define(
  "FinancePurchaseOrder",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // Identifiant métier généré par l'application (§IDENTIFICATION DES
    // DIFFÉRENTS PURCHASE ORDERS) — format "PO-00001", UNIQUE, un seul par
    // Purchase Order, JAMAIS extrait/deviné (contrairement à `orderNumber`
    // ci-dessous, qui reste un champ OCR nullable/non-unique). Voir
    // finance.service.js#generatePoNumber.
    poNumber: { type: DataTypes.STRING(20), allowNull: true, unique: true },

    orderNumber: { type: DataTypes.STRING(100), allowNull: true },
    orderDate: { type: DataTypes.DATEONLY, allowNull: true },

    customerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "clients", key: "id" },
    },
    // Instantané client tel que LU sur le document — jamais résolu
    // automatiquement vers un client existant (même convention que
    // FinanceInvoice/FinanceShipment).
    customerCode: { type: DataTypes.STRING(100), allowNull: true },
    customerName: { type: DataTypes.STRING(255), allowNull: true },
    customerAddress: { type: DataTypes.TEXT, allowNull: true },
    // Adresse de LIVRAISON — bloc distinct de l'adresse client, jamais fusionné.
    deliveryAddress: { type: DataTypes.TEXT, allowNull: true },

    totalHT: { type: DataTypes.DECIMAL(14, 3), allowNull: true },

    ocrConfidence: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    ocrExtraction: { type: DataTypes.JSONB, allowNull: true },

    status: {
      type: DataTypes.ENUM("EXTRACTED", "NEEDS_REVIEW", "OCR_FAILED"),
      allowNull: false,
      defaultValue: "NEEDS_REVIEW",
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
  },
  {
    tableName: "finance_purchase_orders",
    timestamps: true,
    indexes: [{ fields: ["customerId"] }, { fields: ["status"] }, { fields: ["orderNumber"] }],
  }
);

module.exports = FinancePurchaseOrder;
