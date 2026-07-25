"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Table unique pour les deux types de demande RH (congé / autorisation de
// sortie) — mêmes conventions que IndustrialRecord (une table générique,
// champs spécifiques à chaque sous-type laissés `null` pour l'autre type).
const HrRequest = sequelize.define(
  "HrRequest",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    type: { type: DataTypes.ENUM("conge", "sortie"), allowNull: false },
    statut: {
      type: DataTypes.ENUM("en_attente", "acceptee", "refusee", "traitee"),
      allowNull: false,
      defaultValue: "en_attente",
    },

    ticketNo: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      allowNull: false,
      unique: true,
    },

    requestedBy: { type: DataTypes.UUID, allowNull: false },

    employeeNom: { type: DataTypes.STRING(120), allowNull: true },
    employeePrenom: { type: DataTypes.STRING(120), allowNull: true },
    employeeMatricule: { type: DataTypes.STRING(50), allowNull: true },
    employeeQualification: { type: DataTypes.STRING(150), allowNull: true },
    employeeDepartement: { type: DataTypes.STRING(150), allowNull: true },
    employeeService: { type: DataTypes.STRING(150), allowNull: true },
    employeeEmail: { type: DataTypes.STRING(200), allowNull: true },

    typeConge: { type: DataTypes.ENUM("ordinaire", "maladie"), allowNull: true },
    dateDebut: { type: DataTypes.DATEONLY, allowNull: true },
    dateFin: { type: DataTypes.DATEONLY, allowNull: true },
    nombreJours: { type: DataTypes.INTEGER, allowNull: true },
    anneeConge: { type: DataTypes.INTEGER, allowNull: true },
    adresse: { type: DataTypes.STRING(255), allowNull: true },
    telephone: { type: DataTypes.STRING(50), allowNull: true },

    motif: { type: DataTypes.STRING(255), allowNull: true },
    dateSortie: { type: DataTypes.DATEONLY, allowNull: true },
    heureSortie: { type: DataTypes.STRING(5), allowNull: true },
    heureRetour: { type: DataTypes.STRING(5), allowNull: true },

    commentaire: { type: DataTypes.TEXT, allowNull: true },
    signature: { type: DataTypes.STRING(200), allowNull: true },

    emailSentAt: { type: DataTypes.DATE, allowNull: true },

    // ── Workflow de validation (Responsable RH) ──────────────────────────
    reviewComment: { type: DataTypes.TEXT, allowNull: true },
    reviewedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    processedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    processedAt: { type: DataTypes.DATE, allowNull: true },
    justificatifs: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  },
  {
    tableName: "hr_requests",
    timestamps: true,
    indexes: [
      { fields: ["type"] },
      { fields: ["statut"] },
      { fields: ["requestedBy"] },
    ],
  }
);

module.exports = HrRequest;
