"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ArchiveRequest = sequelize.define(
  "ArchiveRequest",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    projectId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "projects", key: "id" },
      onDelete: "CASCADE",
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    adminId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    status: {
      type: DataTypes.ENUM("pending", "approved", "rejected"),
      allowNull: false,
      defaultValue: "pending",
    },
    subject: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    tableName: "archive_requests",
    timestamps: true,
    indexes: [
      { fields: ["projectId"] },
      { fields: ["userId"] },
      { fields: ["status"] },
    ],
  }
);

module.exports = ArchiveRequest;
