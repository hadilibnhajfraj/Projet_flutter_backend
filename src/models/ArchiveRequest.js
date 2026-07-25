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
    // ARCHIVAGE : demande d'archivage d'un projet actif.
    // DESARCHIVAGE : demande de désarchivage (comportement historique).
    type: {
      type: DataTypes.ENUM("ARCHIVAGE", "DESARCHIVAGE"),
      allowNull: false,
      defaultValue: "DESARCHIVAGE",
    },
    subject: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    rejectionReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // Traçabilité explicite de l'action de validation/refus (indépendante de
    // adminId, qui porte la sémantique "admin assigné" depuis la création).
    approvedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    approvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    rejectedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    rejectedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "archive_requests",
    timestamps: true,
    indexes: [
      { fields: ["projectId"] },
      { fields: ["userId"] },
      { fields: ["status"] },
      { fields: ["type"] },
    ],
  }
);

module.exports = ArchiveRequest;
