// models/ProjectBonDeCommande.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectBonDeCommande = sequelize.define(
  "ProjectBonDeCommande",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },

    nomBonDeCommande: { type: DataTypes.STRING(200), allowNull: false },
    fileUrl: { type: DataTypes.STRING(500), allowNull: false },
    mimeType: { type: DataTypes.STRING(100), allowNull: false },
    originalName: { type: DataTypes.STRING(255), allowNull: true },
  },
  { tableName: "project_bon_de_commande", timestamps: true }
);

module.exports = ProjectBonDeCommande;