"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ArchiveRequestMessage = sequelize.define(
  "ArchiveRequestMessage",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    requestId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "archive_requests", key: "id" },
      onDelete: "CASCADE",
    },
    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    tableName: "archive_request_messages",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["requestId"] },
      { fields: ["senderId"] },
    ],
  }
);

module.exports = ArchiveRequestMessage;
