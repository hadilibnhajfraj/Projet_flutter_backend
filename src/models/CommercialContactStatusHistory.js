// models/CommercialContactStatusHistory.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContactStatusHistory = sequelize.define(
  "CommercialContactStatusHistory",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    commercialContactId: { type: DataTypes.UUID, allowNull: false },

    // "statut" | "pipelineStage"
    field: { type: DataTypes.STRING(20), allowNull: false },

    // "CREATED" (toute première entrée, à la création du contact) |
    // "STATUS_CHANGED" (tout changement ultérieur).
    type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "STATUS_CHANGED" },

    ancienStatut: { type: DataTypes.STRING(50), allowNull: true },
    nouveauStatut: { type: DataTypes.STRING(50), allowNull: false },

    commentaire: { type: DataTypes.TEXT, allowNull: true },

    changedBy: { type: DataTypes.UUID, allowNull: false },
    changedByName: { type: DataTypes.STRING(200), allowNull: true },
  },
  {
    tableName: "commercial_contact_status_histories",
    timestamps: true,
    updatedAt: false, // append-only : pas de notion de "modifié le"
  }
);

module.exports = CommercialContactStatusHistory;
