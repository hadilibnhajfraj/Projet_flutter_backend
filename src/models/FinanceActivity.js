// models/FinanceActivity.js
"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Journal d'audit UNIFIÉ du module Finance (§16 du cahier des charges cadre
// "Audit / Historique" comme un seul concept transverse à
// documents/shipments/invoices/payments) — contrairement au reste de
// l'application où chaque module a sa propre table d'activité 1-FK
// (ProjectActivity/HrRequestActivity/MaintenanceRequestActivity), celle-ci
// utilise `entityType` + `entityId` (référence douce, pas de FK dure —
// polymorphe sur 4 tables) pour couvrir tout le module Finance dans une
// seule table plutôt que 4 tables quasi identiques.
const FinanceActivity = sequelize.define(
  "FinanceActivity",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    entityType: { type: DataTypes.STRING(40), allowNull: false }, // DOCUMENT | SHIPMENT | INVOICE | PAYMENT
    entityId: { type: DataTypes.UUID, allowNull: false },

    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },

    type: { type: DataTypes.STRING(50), allowNull: false },
    message: { type: DataTypes.STRING(500), allowNull: false },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "finance_activities",
    timestamps: true,
    indexes: [{ fields: ["entityType", "entityId"] }, { fields: ["userId"] }, { fields: ["type"] }, { fields: ["createdAt"] }],
  }
);

module.exports = FinanceActivity;
