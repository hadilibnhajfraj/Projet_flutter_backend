"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Historique d'une note de calcul (création, modifications, documents).
const CalculationNoteHistory = sequelize.define(
  "CalculationNoteHistory",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    noteId: { type: DataTypes.INTEGER, allowNull: false },
    documentId: { type: DataTypes.UUID, allowNull: true },
    // NOTE_CREATED | NOTE_UPDATED | DOCUMENT_ADDED | DOCUMENT_COMMENT_UPDATED
    action: { type: DataTypes.STRING(40), allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    details: { type: DataTypes.JSONB, allowNull: true },
  },
  { tableName: "calculation_note_histories", timestamps: true, updatedAt: false }
);

module.exports = CalculationNoteHistory;
