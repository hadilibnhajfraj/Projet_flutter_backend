"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Fiche "Récupérables Traités" — identifiée par (module, machine, ligne,
// poste, date), unique (contrainte DB). Reste ouverte 6 jours à partir de
// createdAt (bascule automatique) ou jusqu'à ce que l'opérateur clique sur
// "Terminer" (statut basculé manuellement, même colonne `statut`).
const RecuperableFiche = sequelize.define(
  "RecuperableFiche",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    module: { type: DataTypes.ENUM("PROBAR", "PROMESH"), allowNull: false },
    
    machine: { type: DataTypes.STRING(50), allowNull: false },
    ligne: { type: DataTypes.ENUM("L1", "L2", "L3", "L4"), allowNull: false },
    poste: { type: DataTypes.ENUM("matin", "soir"), allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    operateur: { type: DataTypes.STRING(255), allowNull: true },

    statut: {
      type: DataTypes.ENUM("en_cours", "cloturee"),
      allowNull: false,
      defaultValue: "en_cours",
    },
    dateCloture: { type: DataTypes.DATEONLY, allowNull: false },

    createdBy: { type: DataTypes.UUID, allowNull: false },
  },
  {
    tableName: "recuperable_fiches",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["module", "machine", "ligne", "poste", "date"],
        name: "recuperable_fiches_module_machine_ligne_poste_date_unique",
      },
      { fields: ["statut"] },
      { fields: ["createdBy"] },
    ],
  }
);

module.exports = RecuperableFiche;
