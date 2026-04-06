const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");
const Client = sequelize.define(
  "Client",
  {
    code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    raisonSociale: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    adresse: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    codePostal: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    region: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    creeLe: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    regime: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    matriculeFiscal: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    identifiantUnique: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    contact: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    derniereFacturation: {
  type: DataTypes.DATEONLY,
  allowNull: true,
},
  },
  {
    tableName: "clients",
    timestamps: true,
  }
);

module.exports = Client;