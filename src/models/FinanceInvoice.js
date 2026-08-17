// models/FinanceInvoice.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Factured shipments - by facture / Paid factures — statuts alignés
// exactement sur le cahier des charges (§8) : Issued, Partially paid, Paid,
// Overdue, Cancelled.
const FinanceInvoice = sequelize.define(
  "FinanceInvoice",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    invoiceNumber: { type: DataTypes.STRING(100), allowNull: false, unique: true },

    shipmentId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "finance_shipments", key: "id" },
      onDelete: "SET NULL",
    },
    // "Upload invoice" simplifié : plus de champ Customer/Date dans le
    // formulaire — la facture est créée automatiquement à partir des
    // documents uploadés, donc ces deux colonnes sont désormais optionnelles
    // (voir migration 20260813000800, même situation que FinanceShipment).
    customerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "clients", key: "id" },
    },

    invoiceDate: { type: DataTypes.DATEONLY, allowNull: true },

    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    tax: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    total: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },

    // Lecture automatique OCR (voir migration 20260814000100) — instantané
    // client tel que LU sur le document, jamais un lien dur vers `clients`
    // (le nom/téléphone/adresse extraits ne correspondent pas forcément à un
    // client déjà en base). `reference` = référence libre imprimée sur la
    // facture, distincte de `invoiceNumber`.
    reference: { type: DataTypes.STRING(150), allowNull: true },
    customerName: { type: DataTypes.STRING(255), allowNull: true },
    customerPhone: { type: DataTypes.STRING(50), allowNull: true },
    customerAddress: { type: DataTypes.TEXT, allowNull: true },
    customerGovernorate: { type: DataTypes.STRING(100), allowNull: true },
    customerTaxId: { type: DataTypes.STRING(100), allowNull: true },
    // "C MF" — code client tel qu'imprimé sur le document (ex. "C1836134R"),
    // distinct de `customerTaxId` qui en dérive en retirant le préfixe "C"
    // (ex. "1836134R") — voir invoiceFieldExtraction.service.js#extractCustomer.
    customerCode: { type: DataTypes.STRING(100), allowNull: true },
    // Confiance globale (0-100) et extraction structurée brute (par champ,
    // avec confiance individuelle + texte OCR) — trace d'audit pour une
    // future relecture/correction manuelle.
    ocrConfidence: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    ocrExtraction: { type: DataTypes.JSONB, allowNull: true },

    // Bloc bas de facture (§CORRIGER L'EXTRACTION DES FACTURES) — Acompte,
    // NET A PAYER, Conditions de règlement et montant en lettres, lus tels
    // quels sur le document (migration 20260816000100). `paymentMethod` ici
    // est le mode IMPRIMÉ SUR LE DOCUMENT (ex. "Traite"), distinct du mode
    // choisi par l'utilisateur à l'enregistrement d'un paiement réel (voir
    // FinancePayment.method).
    downPayment: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    netToPay: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    paymentCondition: { type: DataTypes.STRING(150), allowNull: true },
    paymentDate: { type: DataTypes.DATEONLY, allowNull: true },
    paymentMethod: { type: DataTypes.STRING(50), allowNull: true },
    amountInWords: { type: DataTypes.TEXT, allowNull: true },

    status: {
      type: DataTypes.ENUM("ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED", "NEEDS_REVIEW", "EXTRACTED", "OCR_FAILED"),
      allowNull: false,
      defaultValue: "ISSUED",
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
  },
  {
    tableName: "finance_invoices",
    timestamps: true,
    indexes: [
      { fields: ["shipmentId"] },
      { fields: ["customerId"] },
      { fields: ["status"] },
      { fields: ["invoiceNumber"] },
    ],
  }
);

module.exports = FinanceInvoice;
