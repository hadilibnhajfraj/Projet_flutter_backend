"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const HrRequestActivity = sequelize.define(
  "HrRequestActivity",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    requestId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "hr_requests", key: "id" },
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
    tableName: "hr_request_activities",
    timestamps: true,
    indexes: [{ fields: ["requestId"] }],
  }
);

module.exports = HrRequestActivity;
