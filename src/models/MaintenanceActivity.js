"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Historique des demandes de maintenance (industrial_records, module
// 'maintenance') — même pattern que ProjectActivity.js, mais lié à
// industrial_records au lieu de projects.
const MaintenanceActivity = sequelize.define(
  "MaintenanceActivity",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    industrialRecordId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "industrial_records", key: "id" },
      onDelete: "CASCADE",
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    type: {
      type: DataTypes.STRING(50),
      allowNull: false,
      // maintenance_request_created | maintenance_request_approved | maintenance_request_rejected
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "maintenance_activities",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["industrialRecordId"] },
      { fields: ["userId"] },
      { fields: ["type"] },
      { fields: ["createdAt"] },
    ],
  }
);

module.exports = MaintenanceActivity;
