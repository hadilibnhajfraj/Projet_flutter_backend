"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Module CONTRÔLE QUALITÉ — un RELEVÉ périodique d'une fiche de contrôle
// qualité (QualityControl) : une heure de contrôle + ses paramètres
// (QualityControlItem.readingId). Une fiche porte plusieurs relevés (08:00,
// 11:00, 14:00…), une seule fois par heure (index unique).
//
// Statut du relevé : BROUILLON (validatedAt null — modifiable, supprimable)
// ou VALIDÉ (lecture seule). Résultat : status (EN_ATTENTE / EN_COURS =
// à vérifier, CONFORME, NON_CONFORME).
const QualityControlReading = sequelize.define(
  "QualityControlReading",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    qualityControlId: { type: DataTypes.UUID, allowNull: false },
    // Rang de l'étape dans la fiche (dernier rang + 1) — l'heure n'identifie
    // jamais un relevé.
    sequence: { type: DataTypes.INTEGER, allowNull: false },
    // Heure du contrôle (HH:mm) — distincte de l'heure d'ouverture de la fiche.
    readingTime: { type: DataTypes.TIME, allowNull: false },
    // EN_ATTENTE | EN_COURS | CONFORME | NON_CONFORME
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "EN_ATTENTE" },
    validatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "quality_control_readings",
    timestamps: true,
  }
);

module.exports = QualityControlReading;
