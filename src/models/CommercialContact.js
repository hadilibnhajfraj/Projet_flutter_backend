const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContact = sequelize.define(
  "CommercialContact",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    typeClient: {
      type: DataTypes.ENUM("Tuteur", "Cloture", "autre"),
      allowNull: false,
      defaultValue: "autre",
    },

    nomSociete: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },

    nom: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },

    prenom: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },

    localisation: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    telephone: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },

    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    statut: {
      type: DataTypes.ENUM(
        "ok",
        "rappeler_plus_tard",
        "user_injoignable",
        "client_refuse"
      ),
      allowNull: false,
      defaultValue: "user_injoignable",
    },

    nbAppels: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    sujetDiscussion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    tableName: "commercial_contacts",
    timestamps: true,
  }
);

module.exports = CommercialContact;