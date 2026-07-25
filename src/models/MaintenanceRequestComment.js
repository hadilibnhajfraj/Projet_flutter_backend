"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const MaintenanceRequestComment = sequelize.define(
  "MaintenanceRequestComment",
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
    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    message: { type: DataTypes.TEXT, allowNull: false },
  },
  {
    tableName: "maintenance_request_comments",
    timestamps: true,
    indexes: [{ fields: ["requestId"] }],
  }
);

module.exports = MaintenanceRequestComment;
