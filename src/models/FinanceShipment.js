// models/FinanceShipment.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Shipment of products to the customers — `customerId` référence la table
// `clients` déjà existante (clients.id est un INTEGER autoincrement, PAS un
// UUID — vérifié en base avant d'écrire ce modèle). `products` reste un
// JSONB de lignes {designation, quantity, unit} : ce sont de simples lignes
// de formulaire, jamais interrogées indépendamment, donc pas de table enfant
// dédiée pour rester simple.
const FinanceShipment = sequelize.define(
  "FinanceShipment",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    reference: { type: DataTypes.STRING(100), allowNull: false, unique: true },

    // "New shipment" simplifié : plus de champ Customer/Date dans le
    // formulaire — le Shipment est créé automatiquement à partir des
    // documents uploadés, donc ces deux colonnes sont désormais optionnelles
    // (voir migration 20260813000700).
    customerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "clients", key: "id" },
    },

    shipmentDate: { type: DataTypes.DATEONLY, allowNull: true },

    products: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    totalQuantity: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    totalAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },

    deliveryInfo: { type: DataTypes.TEXT, allowNull: true },

    // Lecture automatique du Bon de Livraison (OCR, voir migration
    // 20260814000300) — `customerReference` est un champ DISTINCT de
    // `reference` (notre clé interne) : c'est la référence secondaire
    // propre au document. Instantané client/livraison, jamais lié en dur à
    // `clients` (customerId reste utilisable séparément).
    customerReference: { type: DataTypes.STRING(150), allowNull: true },
    customerName: { type: DataTypes.STRING(255), allowNull: true },
    customerTaxId: { type: DataTypes.STRING(100), allowNull: true },
    // Code client (ex. "C1745741E") lu sur la 1re ligne du bloc "Adresse
    // Siège" — distinct de customerTaxId, voir extractHeadOfficeBlock.
    customerCode: { type: DataTypes.STRING(100), allowNull: true },
    customerAddress: { type: DataTypes.TEXT, allowNull: true },
    customerGovernorate: { type: DataTypes.STRING(100), allowNull: true },
    customerHeadOfficeAddress: { type: DataTypes.TEXT, allowNull: true },
    customerPhone: { type: DataTypes.STRING(50), allowNull: true },
    truckRegistration: { type: DataTypes.STRING(50), allowNull: true },
    truckManufacturer: { type: DataTypes.STRING(100), allowNull: true },
    driverName: { type: DataTypes.STRING(150), allowNull: true },
    deliveryAddress: { type: DataTypes.TEXT, allowNull: true },
    ocrConfidence: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    ocrExtraction: { type: DataTypes.JSONB, allowNull: true },

    status: {
      type: DataTypes.ENUM("DRAFT", "PREPARED", "SHIPPED", "DELIVERED", "CANCELLED", "NEEDS_REVIEW", "EXTRACTED", "OCR_FAILED"),
      allowNull: false,
      defaultValue: "DRAFT",
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
  },
  {
    tableName: "finance_shipments",
    timestamps: true,
    indexes: [{ fields: ["customerId"] }, { fields: ["reference"] }, { fields: ["status"] }],
  }
);

module.exports = FinanceShipment;
