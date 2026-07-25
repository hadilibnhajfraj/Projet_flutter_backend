"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const MaintenanceRequestActivity = sequelize.define(
  "MaintenanceRequestActivity",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    requestId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "maintenance_requests", key: "id" },
      onDelete: "CASCADE",
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    type: { type: DataTypes.STRING(80), allowNull: false },
    message: { type: DataTypes.STRING(500), allowNull: false },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "maintenance_request_activities",
    timestamps: true,
    indexes: [{ fields: ["requestId"] }],
  }
);

module.exports = MaintenanceRequestActivity;
