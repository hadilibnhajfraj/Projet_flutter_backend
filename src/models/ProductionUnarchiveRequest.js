"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const STATUSES = ["PENDING", "APPROVED", "REJECTED"];

// Demande de désarchivage d'une fiche PROMESH/PROBAR archivée automatiquement
// — voir modules/production-draft-archive/services/unarchiveRequests.service.js.
const ProductionUnarchiveRequest = sequelize.define(
  "ProductionUnarchiveRequest",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    ficheType: { type: DataTypes.STRING(20), allowNull: false },
    ficheId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    userEmail: { type: DataTypes.STRING(255), allowNull: false },
    dateProduction: { type: DataTypes.DATEONLY, allowNull: true },
    machine: { type: DataTypes.STRING(50), allowNull: true },
    poste: { type: DataTypes.STRING(50), allowNull: true },
    ficheCreatedAt: { type: DataTypes.DATE, allowNull: false },
    archivedAt: { type: DataTypes.DATE, allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PENDING", validate: { isIn: [STATUSES] } },
    requestedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewedBy: { type: DataTypes.UUID, allowNull: true },
    reviewerEmail: { type: DataTypes.STRING(255), allowNull: true },
    reviewNote: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "production_unarchive_requests",
    timestamps: true,
  }
);

ProductionUnarchiveRequest.STATUSES = STATUSES;

module.exports = ProductionUnarchiveRequest;
