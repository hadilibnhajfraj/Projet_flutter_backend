"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Module CONTRÔLE QUALITÉ — une fiche de contrôle qualité appartient à une
// MACHINE (productionType PROMESH | PROBAR + machine, obligatoires), créée
// par le rôle controle_qualite (controllerUserId / controllerEmail = auteur,
// posés par le serveur depuis le JWT). La fiche de PRODUCTION contrôlée
// (por_promesh / industrial_records PROBAR) est une association OPTIONNELLE
// (productionRecordId + instantané ficheNumero), calculée par le SERVEUR à
// partir de ligne + machine + date de production + poste — jamais choisie
// par l'utilisateur ni affichée dans le formulaire. Distinct de
// PorPromeshControleQualite (mesures saisies par l'opérateur dans la fiche).
//
// Statut de la fiche : BROUILLON (validatedAt null) | VALIDÉ (lecture seule).
// Résultat : status (EN_ATTENTE / EN_COURS = à vérifier, CONFORME,
// NON_CONFORME).
// Suppression logique uniquement (paranoid) : l'historique n'est jamais perdu.
const QualityControl = sequelize.define(
  "QualityControl",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    // Référence lisible et unique de la fiche qualité (QC-AAAA-NNNNN).
    reference: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    // Fiche de production associée — OPTIONNELLE.
    productionRecordId: { type: DataTypes.UUID, allowNull: true },
    productionType: { type: DataTypes.STRING(10), allowNull: false }, // PROMESH | PROBAR
    ficheNumero: { type: DataTypes.STRING(40), allowNull: true },
    machine: { type: DataTypes.STRING(50), allowNull: true },
    poste: { type: DataTypes.STRING(20), allowNull: true },
    productionDate: { type: DataTypes.DATEONLY, allowNull: true },
    // Lot / ordre de fabrication : repris AUTOMATIQUEMENT de la fiche de
    // production associée quand elle les porte (lotAuto /
    // manufacturingOrderAuto = true → lecture seule) ; sinon saisis par le
    // contrôleur. Vides par défaut.
    lot: { type: DataTypes.STRING(100), allowNull: true },
    manufacturingOrder: { type: DataTypes.STRING(100), allowNull: true },
    lotAuto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    manufacturingOrderAuto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
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
