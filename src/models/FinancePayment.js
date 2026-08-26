// models/FinancePayment.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Un paiement enregistré contre une facture — plusieurs paiements partiels
// possibles par facture (Invoice.status passe à PARTIALLY_PAID/PAID selon la
// somme des paiements, voir finance.service.js#registerPayment).
const FinancePayment = sequelize.define(
  "FinancePayment",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    invoiceId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "finance_invoices", key: "id" },
      onDelete: "CASCADE",
    },

    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    paidDate: { type: DataTypes.DATEONLY, allowNull: false },
    // "Register payment" (§REGISTER PAYMENT) — dropdown fermé, validé côté
    // serveur : Virement | Versement | Chèque | Traite. Les champs
    // ci-dessous restent NULL (formulaire minimal, plus collectés par l'UI —
    // jamais une valeur inventée pour un mode qui n'en a pas besoin).
    method: { type: DataTypes.STRING(100), allowNull: true },
    reference: { type: DataTypes.STRING(150), allowNull: true },
    chequeNumber: { type: DataTypes.STRING(100), allowNull: true },
    bankName: { type: DataTypes.STRING(150), allowNull: true },
    chequeDate: { type: DataTypes.DATEONLY, allowNull: true },
    billOfExchangeNumber: { type: DataTypes.STRING(100), allowNull: true },
    dueDate: { type: DataTypes.DATEONLY, allowNull: true },

    registeredBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
  },
  {
    tableName: "finance_payments",
    timestamps: true,
    indexes: [{ fields: ["invoiceId"] }],
  }
);

module.exports = FinancePayment;
