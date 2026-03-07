// models/CommercialContact.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContact = sequelize.define(
  "CommercialContact",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // type client: exemple (à adapter)
    typeClient: {
      type: DataTypes.ENUM("Tuteur", "Cloture"),
      allowNull: false,
      defaultValue: "autre",
    },

    nomSociete: { type: DataTypes.STRING(200), allowNull: true },
    nom: { type: DataTypes.STRING(120), allowNull: false },
    prenom: { type: DataTypes.STRING(120), allowNull: false },

    localisation: { type: DataTypes.STRING(255), allowNull: true },

    telephone: { type: DataTypes.STRING(40), allowNull: false },

    message: { type: DataTypes.TEXT, allowNull: true },

    // qui a créé (commercial connecté)
    createdBy: { type: DataTypes.UUID, allowNull: false },
  },
  { tableName: "commercial_contacts", timestamps: true }
);

module.exports = CommercialContact;