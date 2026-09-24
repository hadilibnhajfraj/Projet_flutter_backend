"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const TYPES = ["BACKFILL_PREVIOUS_PRODUCTION", "BYPASS_MISSING_PRODUCTION_DATE"];

const ProductionComplianceAuthorization = sequelize.define(
  "ProductionComplianceAuthorization",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    productionType: { type: DataTypes.STRING(20), allowNull: false },
    productionDate: { type: DataTypes.DATEONLY, allowNull: false },
    type: { type: DataTypes.STRING(40), allowNull: false, validate: { isIn: [TYPES] } },
    authorizedBy: { type: DataTypes.UUID, allowNull: false },
    authorizedByEmail: { type: DataTypes.STRING(255), allowNull: false },
    authorizedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: true },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    revokedBy: { type: DataTypes.UUID, allowNull: true },
    usedAt: { type: DataTypes.DATE, allowNull: true },
    usedFicheType: { type: DataTypes.STRING(20), allowNull: true },
    usedFicheId: { type: DataTypes.UUID, allowNull: true },
  },
  { tableName: "production_compliance_authorizations", timestamps: true }
);

ProductionComplianceAuthorization.TYPES = TYPES;

module.exports = ProductionComplianceAuthorization;
