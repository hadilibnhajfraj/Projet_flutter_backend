"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Journal append-only du module CONTRÔLE QUALITÉ — une ligne par champ
// modifié (ancienne valeur → nouvelle valeur, utilisateur, horodatage).
// Jamais mis à jour ni supprimé par l'application.
const QualityControlHistory = sequelize.define(
  "QualityControlHistory",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    qualityControlId: { type: DataTypes.UUID, allowNull: false },
    // CREATE | UPDATE | VALIDATE | STATUS_CHANGE | DELETE
    action: { type: DataTypes.STRING(30), allowNull: false },
    parameterKey: { type: DataTypes.STRING(50), allowNull: true },
    field: { type: DataTypes.STRING(30), allowNull: true },
    oldValue: { type: DataTypes.TEXT, allowNull: true },
    newValue: { type: DataTypes.TEXT, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: true },
    userId: { type: DataTypes.UUID, allowNull: true },
    userEmail: { type: DataTypes.STRING(200), allowNull: true },
    changedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "quality_control_history",
    timestamps: false,
  }
);

module.exports = QualityControlHistory;
