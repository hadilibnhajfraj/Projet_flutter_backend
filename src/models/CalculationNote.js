"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Note de calcul liée à un projet CRM (module « Notes de calcul »).
// id : séquence PostgreSQL (SERIAL) ; reference : NC-AAAA-NNNN générée par
// le backend (compteur annuel transactionnel, voir
// modules/calculation-notes/services/calculationNoteNumbering.js).
const CalculationNote = sequelize.define(
  "CalculationNote",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    reference: { type: DataTypes.STRING(30), allowNull: false, unique: true },
    year: { type: DataTypes.INTEGER, allowNull: false },
    sequenceNumber: { type: DataTypes.INTEGER, allowNull: false },
    projectId: { type: DataTypes.UUID, allowNull: false },
    requesterId: { type: DataTypes.UUID, allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: false },
    commentaire: { type: DataTypes.TEXT, allowNull: true },
    // Validation (config/calculationNoteValidation.js) : validateur figé par
    // son ID à la soumission ; décision et annulation horodatées.
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "EN_ATTENTE_VALIDATION" },
    validatorId: { type: DataTypes.UUID, allowNull: true },
    submissionVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    submittedAt: { type: DataTypes.DATE, allowNull: true },
    decidedBy: { type: DataTypes.UUID, allowNull: true },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionComment: { type: DataTypes.TEXT, allowNull: true },
    cancelledBy: { type: DataTypes.UUID, allowNull: true },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    cancellationReason: { type: DataTypes.TEXT, allowNull: true },
    // Affectation à un utilisateur CRM responsable (migration 20261106090000).
    assignedToUserId: { type: DataTypes.UUID, allowNull: true },
    assignedAt: { type: DataTypes.DATE, allowNull: true },
    assignedByUserId: { type: DataTypes.UUID, allowNull: true },
    assignmentVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // N° du dernier dépôt de documents complémentaires (0 = aucun).
    complementaryVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { tableName: "calculation_notes", timestamps: true }
);

module.exports = CalculationNote;
