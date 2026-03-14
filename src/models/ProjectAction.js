// models/ProjectAction.js

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectAction = sequelize.define(
  "ProjectAction",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    projectId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    typeAction: {
  type: DataTypes.ENUM(
    "Visite",
    "Plan technique",
    "Echantillonnage",
    "Devis envoyé",
    "Negociation",
    "Relance",
    "Commande gagnée",
    "Commande perdue"
  ),
  allowNull: false
},

    commentaire: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    dateAction: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },

    // rappel futur
    dateRelance: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    statut: {
      type: DataTypes.ENUM(
        "A faire",
        "En cours",
        "Terminé"
      ),
      defaultValue: "A faire",
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    tableName: "project_actions",
    timestamps: true,
  }
);

module.exports = ProjectAction;