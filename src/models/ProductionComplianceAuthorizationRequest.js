"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "USED"];

const ProductionComplianceAuthorizationRequest = sequelize.define(
  "ProductionComplianceAuthorizationRequest",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    userEmail: { type: DataTypes.STRING(255), allowNull: false },
    productionType: { type: DataTypes.STRING(20), allowNull: false },
    missingDate: { type: DataTypes.DATEONLY, allowNull: false }, // compat : première date manquante — voir missingDates
    missingDates: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // toutes les dates manquantes couvertes par cette demande
    requestedDate: { type: DataTypes.DATEONLY, allowNull: false },
    authorizationType: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "BACKFILL_PREVIOUS_PRODUCTION" },
    reason: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PENDING", validate: { isIn: [STATUSES] } },
    requestedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewedBy: { type: DataTypes.UUID, allowNull: true },
    reviewerEmail: { type: DataTypes.STRING(255), allowNull: true },
    reviewNote: { type: DataTypes.TEXT, allowNull: true },
    createdAuthorizationId: { type: DataTypes.UUID, allowNull: true }, // compat : première autorisation créée — voir createdAuthorizationIds
    createdAuthorizationIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // une autorisation par date de missingDates
    emailStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "PENDING" }, // PENDING | SENT | FAILED
    emailError: { type: DataTypes.TEXT, allowNull: true },
    emailSentAt: { type: DataTypes.DATE, allowNull: true },
    lastEmailAttemptAt: { type: DataTypes.DATE, allowNull: true },
    retryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { tableName: "production_compliance_authorization_requests", timestamps: true }
);

ProductionComplianceAuthorizationRequest.STATUSES = STATUSES;

module.exports = ProductionComplianceAuthorizationRequest;
