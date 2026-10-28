"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Historique des statuts d'une demande de matières premières : une ligne par
// changement (fromStatus null = création), avec auteur, date et commentaire.
const RawMaterialRequestStatusHistory = sequelize.define(
  "RawMaterialRequestStatusHistory",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    requestId: { type: DataTypes.UUID, allowNull: false },
    fromStatus: { type: DataTypes.STRING(30), allowNull: true },
    toStatus: { type: DataTypes.STRING(30), allowNull: false },
    changedBy: { type: DataTypes.UUID, allowNull: true },
    changedByEmail: { type: DataTypes.STRING(255), allowNull: true },
    comment: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "raw_material_request_status_histories",
    timestamps: true,
    indexes: [{ fields: ["requestId", "createdAt"] }],
  }
);

module.exports = RawMaterialRequestStatusHistory;
