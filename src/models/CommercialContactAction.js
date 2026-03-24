const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContactAction = sequelize.define(
  "CommercialContactAction",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    commercialContactId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    fileUrl: {
      type: DataTypes.STRING,
      allowNull: true,
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
      allowNull: false,
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
    tableName: "commercial_contact_actions",
    timestamps: true,
  }
);

module.exports = CommercialContactAction;