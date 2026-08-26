const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Table générique partagée par les modules PROBAR, MÉLANGE et MAINTENANCE
// (pas de schéma métier dédié par module — voir plan UX module industriel).
const IndustrialRecord = sequelize.define(
  "IndustrialRecord",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    module: { type: DataTypes.ENUM("probar", "melange", "maintenance"), allowNull: false },

    machine: { type: DataTypes.STRING(50), allowNull: true },
    poste: { type: DataTypes.ENUM("matin", "nuit"), allowNull: true },
    dateFiche: { type: DataTypes.DATEONLY, allowNull: false },
    operateur: { type: DataTypes.STRING(255), allowNull: true },

    quantiteProduite: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    statutQualite: { type: DataTypes.ENUM("ok", "nok"), allowNull: true },

    typePanne: { type: DataTypes.STRING(255), allowNull: true },
    urgence: { type: DataTypes.ENUM("faible", "moyenne", "critique"), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    observations: { type: DataTypes.TEXT, allowNull: true },

    // §MODIFICATION — FICHE MÉLANGE : champs structurés dédiés (module
    // 'melange' uniquement — null pour PROBAR/MAINTENANCE, même convention
    // que melangeData ci-dessous).
    heureDebut: { type: DataTypes.TIME, allowNull: true },
    heureFin: { type: DataTypes.TIME, allowNull: true },
    promesh: { type: DataTypes.STRING(20), allowNull: true },
    // §MODIFICATION — FICHE MÉLANGE (simplification) : renommé depuis
    // "echantillon" — voir migration 20260824020000.
    dechet: { type: DataTypes.STRING(255), allowNull: true },

    // Champ dédié au module MÉLANGE — stocke le JSON complet du formulaire
    // sans limitation de taille. Les autres modules (PROBAR, MAINTENANCE) laissent ce champ null.
    melangeData: { type: DataTypes.JSONB, allowNull: true },

    statut: { type: DataTypes.STRING(50), allowNull: false, defaultValue: "enregistree" },

    createdBy: { type: DataTypes.UUID, allowNull: false },
  },
  {
    tableName: "industrial_records",
    timestamps: true,
    indexes: [
      { fields: ["module"] },
      { fields: ["machine"] },
      { fields: ["dateFiche"] },
      { fields: ["createdBy"] },
      // Couvre WHERE module = ? ORDER BY dateFiche DESC, createdAt DESC
      // (requête de listRecords) sans tri Postgres séparé.
      { fields: ["module", "dateFiche", "createdAt"], name: "industrial_records_module_datefiche_createdat" },
    ],
  }
);

module.exports = IndustrialRecord;
