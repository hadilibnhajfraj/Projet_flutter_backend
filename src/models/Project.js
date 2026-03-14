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

    // ✅ NOUVEAU
    dateProspection: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },

    typeAdresseChantier: { type: DataTypes.STRING(255), allowNull: false },

    ingenieurResponsable: { type: DataTypes.STRING(200), allowNull: false },
    telephoneIngenieur: { type: DataTypes.STRING(30), allowNull: false },

    // ✅ NOUVEAU EMAIL INGENIEUR
    emailIngenieur: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },

    architecte: { type: DataTypes.STRING(200), allowNull: true },
    telephoneArchitecte: { type: DataTypes.STRING(30), allowNull: true },

    // ✅ NOUVEAU EMAIL ARCHITECTE
    emailArchitecte: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },

    matriculeFiscale: {
      type: DataTypes.STRING(60),
      allowNull: true,
    },

    entreprise: { type: DataTypes.STRING(200), allowNull: false },

    promoteur: { type: DataTypes.STRING(200), allowNull: true },

    bureauEtude: { type: DataTypes.STRING(200), allowNull: true },

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

    pourcentageReussite: {
      type: DataTypes.DECIMAL(5, 2),
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
pipelineStage: {
  type: DataTypes.ENUM(
    "Prospect",
    "Contacté",
    "Visite",
    "Devis envoyé",
    "Negociation",
    "Gagné",
    "Perdu"
  ),
  defaultValue: "Prospect",
},
    surfaceProspectee: {
      type: DataTypes.DECIMAL(12, 2),
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