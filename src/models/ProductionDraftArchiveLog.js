"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Une ligne par événement d'archivage automatique (et, le cas échéant, de
// désarchivage) d'une fiche brouillon PROMESH/PROBAR — voir
// modules/production-draft-archive/services/draftArchive.service.js.
const ProductionDraftArchiveLog = sequelize.define(
  "ProductionDraftArchiveLog",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    ficheType: { type: DataTypes.STRING(20), allowNull: false }, // "PROMESH" | "PROBAR"
    ficheId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    userEmail: { type: DataTypes.STRING(255), allowNull: false },
    dateProduction: { type: DataTypes.DATEONLY, allowNull: true },
    machine: { type: DataTypes.STRING(50), allowNull: true },
    poste: { type: DataTypes.STRING(50), allowNull: true },
    ficheCreatedAt: { type: DataTypes.DATE, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    archivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    reason: { type: DataTypes.TEXT, allowNull: false },
    action: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "AUTO_ARCHIVED" },
    unarchivedAt: { type: DataTypes.DATE, allowNull: true },
    unarchivedBy: { type: DataTypes.UUID, allowNull: true },
    unarchivedByEmail: { type: DataTypes.STRING(255), allowNull: true },
  },
  {
    tableName: "production_draft_archive_log",
    timestamps: true,
  }
);

module.exports = ProductionDraftArchiveLog;
