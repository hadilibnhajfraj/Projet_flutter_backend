"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Journal APPEND-ONLY des actions des responsables sur les demandes
// Production (autorisation de backfill / désarchivage) — voir
// modules/production-requests. Jamais mis à jour ni supprimé.
const ProductionRequestAudit = sequelize.define(
  "ProductionRequestAudit",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: true },
    userEmail: { type: DataTypes.STRING(255), allowNull: true },
    action: { type: DataTypes.STRING(30), allowNull: false }, // VIEW_HISTORY | VIEW_STATISTICS | APPROVE | REJECT
    requestType: { type: DataTypes.STRING(20), allowNull: true }, // AUTHORIZATION | UNARCHIVE
    requestId: { type: DataTypes.UUID, allowNull: true },
    oldValue: { type: DataTypes.TEXT, allowNull: true },
    newValue: { type: DataTypes.TEXT, allowNull: true },
    outcome: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "SUCCESS" }, // SUCCESS | DENIED | FAILED
    httpStatus: { type: DataTypes.INTEGER, allowNull: true },
    details: { type: DataTypes.JSONB, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "production_request_audit_log",
    timestamps: false,
  }
);

module.exports = ProductionRequestAudit;
