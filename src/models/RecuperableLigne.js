"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Une ligne = un diamètre fixe (12 par fiche, jamais ajoutées/retirées
// dynamiquement) — seules dechetKg et dechetProduitFiniKg sont saisies,
// toujours par défaut à 0 (aucune saisie obligatoire).
const RecuperableLigne = sequelize.define(
  "RecuperableLigne",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    

    ficheId: { type: DataTypes.UUID, allowNull: false },

    diametre: { type: DataTypes.STRING(10), allowNull: false },

    dechetKg: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    dechetProduitFiniKg: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "recuperable_lignes",
    timestamps: true,
    indexes: [
      { fields: ["ficheId"] },
      { unique: true, fields: ["ficheId", "diametre"], name: "recuperable_lignes_fiche_diametre_unique" },
    ],
  }
);

module.exports = RecuperableLigne;
