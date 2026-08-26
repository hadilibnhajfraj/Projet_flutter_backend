// models/FinanceDocument.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Document Finance générique (module Inflow of raw materials + pièces
// jointes Shipment/Invoice/Payment) — `module` discrimine l'usage,
// `entityId` est une référence "douce" (pas de FK dure) vers la ligne
// concernée dans finance_shipments/finance_invoices/finance_payments quand
// applicable ; null pour un document d'inflow autonome, non rattaché à une
// autre table Finance.
const FinanceDocument = sequelize.define(
  "FinanceDocument",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    module: {
      // "OTHER" (§MODIFICATION — FINANCE > OTHER) : stockage documentaire
      // pur, jamais rattaché à une autre entité Finance — `entityId` reste
      // NULL pour ce module, contrairement aux autres valeurs qui référencent
      // (en soft-reference) une ligne finance_shipments/finance_invoices/...
      type: DataTypes.ENUM("INFLOW_RAW_MATERIALS", "SHIPMENT", "INVOICE", "PAYMENT", "OTHER"),
      allowNull: false,
    },
    entityId: { type: DataTypes.UUID, allowNull: true },

    // Nom d'origine tel qu'envoyé par le navigateur, assaini (voir
    // financeDocumentUpload.middleware.js#sanitizeOriginalName) — jamais
    // utilisé pour construire un chemin sur disque.
    originalName: { type: DataTypes.STRING(255), allowNull: false },
    // Nom D'AFFICHAGE modifiable par l'utilisateur (§7/§19 — module "Other"
    // uniquement pour l'instant) — `originalName` reste inchangé, jamais
    // utilisé pour construire un chemin sur disque ni pour retrouver le
    // fichier physique (voir `storedFileName`/`fileUrl`, non affectés par un
    // renommage). `null` pour tout document créé avant l'ajout de ce champ
    // ou par un autre module — le DTO retombe alors sur `originalName`.
    displayName: { type: DataTypes.STRING(255), allowNull: true },
    // Nom réel du fichier sur disque (UUID généré côté serveur).
    storedFileName: { type: DataTypes.STRING(255), allowNull: false },
    fileUrl: { type: DataTypes.STRING(500), allowNull: false },
    mimeType: { type: DataTypes.STRING(150), allowNull: false },
    fileSize: { type: DataTypes.INTEGER, allowNull: false },

    status: {
      type: DataTypes.ENUM("PENDING", "VALIDATED", "REJECTED"),
      allowNull: false,
      defaultValue: "PENDING",
    },

    uploadedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
  },
  {
    tableName: "finance_documents",
    timestamps: true,
    indexes: [{ fields: ["module"] }, { fields: ["entityId"] }, { fields: ["uploadedBy"] }],
  }
);

module.exports = FinanceDocument;
