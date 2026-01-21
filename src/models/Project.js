// models/Project.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Project = sequelize.define(
  "Project",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    nomProjet: { type: DataTypes.STRING(200), allowNull: false },
    dateDemarrage: { type: DataTypes.DATEONLY, allowNull: false },
    typeAdresseChantier: { type: DataTypes.STRING(255), allowNull: false },

    ingenieurResponsable: { type: DataTypes.STRING(200), allowNull: false },
    telephoneIngenieur: { type: DataTypes.STRING(30), allowNull: false },

    architecte: { type: DataTypes.STRING(200), allowNull: false },
    telephoneArchitecte: { type: DataTypes.STRING(30), allowNull: false },

    entreprise: { type: DataTypes.STRING(200), allowNull: false },
    promoteur: { type: DataTypes.STRING(200), allowNull: false },
    bureauEtude: { type: DataTypes.STRING(200), allowNull: false },
    bureauControle: { type: DataTypes.STRING(200), allowNull: false },

    adresse: { type: DataTypes.STRING(255), allowNull: true },

    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    localisationCommentaire: { type: DataTypes.TEXT, allowNull: true },

    statut: {
      type: DataTypes.ENUM("En cours", "Préparation", "Terminé"),
      allowNull: true,
    },

    entrepriseFluide: { type: DataTypes.STRING(200), allowNull: true },
    entrepriseElectricite: { type: DataTypes.STRING(200), allowNull: true },

    // ✅ NOUVEAUX CHAMPS
    pourcentageReussite: {
      type: DataTypes.DECIMAL(5, 2), // ex: 75.50
      allowNull: true,
      validate: { min: 0, max: 100 },
    },

    validationStatut: {
      type: DataTypes.ENUM("Validé", "Non validé"),
      allowNull: true,
      defaultValue: "Non validé",
    },

    typeProjet: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },

    surfaceProspectee: {
      type: DataTypes.DECIMAL(12, 2), // ex: 1200.50 (m²)
      allowNull: true,
      validate: { min: 0 },
    },
  },
  {
    tableName: "projects",
    timestamps: true,
  }
);

module.exports = Project;
