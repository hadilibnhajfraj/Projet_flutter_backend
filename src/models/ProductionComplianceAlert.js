"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProductionComplianceAlert = sequelize.define(
  "ProductionComplianceAlert",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productionType: { type: DataTypes.STRING(20), allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    productionDate: { type: DataTypes.DATEONLY, allowNull: false },
    periodStart: { type: DataTypes.DATE, allowNull: false },
    periodEnd: { type: DataTypes.DATE, allowNull: false },
    sheetsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" }, // pending | sent | failed
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    emailSentAt: { type: DataTypes.DATE, allowNull: true },
    recipients: { type: DataTypes.JSONB, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    checkedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "production_compliance_alerts", timestamps: true }
);

module.exports = ProductionComplianceAlert;
