"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Module CONTRÔLE QUALITÉ — un contrôle = une checklist remplie par le rôle
// controle_qualite sur une fiche PROMESH (por_promesh) ou PROBAR
// (industrial_records, module='probar'). Distinct de
// PorPromeshControleQualite (mesures saisies par l'opérateur dans la fiche).
//
// machine/poste/productionDate/ficheNumero sont un INSTANTANÉ de la fiche au
// moment de la création du contrôle — jamais envoyés par le client.
// Suppression logique uniquement (paranoid) : l'historique n'est jamais perdu.
const QualityControl = sequelize.define(
  "QualityControl",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productionRecordId: { type: DataTypes.UUID, allowNull: false },
    productionType: { type: DataTypes.STRING(10), allowNull: false }, // PROMESH | PROBAR
    ficheNumero: { type: DataTypes.STRING(40), allowNull: true },
    machine: { type: DataTypes.STRING(50), allowNull: true },
    poste: { type: DataTypes.STRING(20), allowNull: true },
    productionDate: { type: DataTypes.DATEONLY, allowNull: true },
    controllerUserId: { type: DataTypes.UUID, allowNull: true },
    controllerEmail: { type: DataTypes.STRING(200), allowNull: false },
    // EN_ATTENTE | EN_COURS | CONFORME | NON_CONFORME
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "EN_ATTENTE" },
    remark: { type: DataTypes.TEXT, allowNull: true },
    // Posés par le serveur à la validation — instant UTC + projection
    // Africa/Tunis (date/heure affichées à l'utilisateur).
    checkedAt: { type: DataTypes.DATE, allowNull: true },
    controlDate: { type: DataTypes.DATEONLY, allowNull: true },
    controlTime: { type: DataTypes.TIME, allowNull: true },
    validatedAt: { type: DataTypes.DATE, allowNull: true },
    deletedBy: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: "quality_controls",
    timestamps: true,
    paranoid: true,
  }
);

module.exports = QualityControl;
