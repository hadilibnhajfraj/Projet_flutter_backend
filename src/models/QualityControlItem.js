"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Un paramètre d'une fiche de contrôle qualité — voir
// config/qualityControl.js#PARAMETERS. Créé à la première saisie.
// - readingId renseigné : contrôle TEMPOREL d'un relevé (unique par relevé
//   et paramètre) ;
// - readingId NULL : PARAMÈTRE PHYSIQUE de la FICHE, indépendant du temps
//   (unique par fiche et paramètre).
const QualityControlItem = sequelize.define(
  "QualityControlItem",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    qualityControlId: { type: DataTypes.UUID, allowNull: false },
    readingId: { type: DataTypes.UUID, allowNull: true },
    parameterKey: { type: DataTypes.STRING(50), allowNull: false },
    parameterName: { type: DataTypes.STRING(100), allowNull: false },
    position: { type: DataTypes.INTEGER, allowNull: false },
    value: { type: DataTypes.STRING(255), allowNull: true },
    // CONFORME | NON_CONFORME | NON_CONTROLE
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "NON_CONTROLE" },
    remark: { type: DataTypes.TEXT, allowNull: true },
    checkedAt: { type: DataTypes.DATE, allowNull: true },
    checkedBy: { type: DataTypes.UUID, allowNull: true },
    checkedByEmail: { type: DataTypes.STRING(200), allowNull: true },
  },
  {
    tableName: "quality_control_items",
    timestamps: true,
  }
);

module.exports = QualityControlItem;
