"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Fichier d'une note de calcul. Stocké HORS du dossier public /uploads (voir
// modules/calculation-notes/middleware/calculationNoteUpload.js) ; seul
// storedFileName (généré par le serveur) sert à retrouver le fichier,
// originalName n'est qu'affiché.
const CalculationNoteDocument = sequelize.define(
  "CalculationNoteDocument",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    noteId: { type: DataTypes.INTEGER, allowNull: false },
    projectId: { type: DataTypes.UUID, allowNull: false },
    originalName: { type: DataTypes.STRING(255), allowNull: false },
    storedFileName: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    extension: { type: DataTypes.STRING(10), allowNull: false },
    mimeType: { type: DataTypes.STRING(120), allowNull: false },
    sizeBytes: { type: DataTypes.BIGINT, allowNull: false },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    commentaire: { type: DataTypes.TEXT, allowNull: true },
    // Nom et type saisis par l'utilisateur (facultatifs).
    title: { type: DataTypes.STRING(255), allowNull: true },
    documentType: { type: DataTypes.STRING(40), allowNull: true },
    // INITIAL (création) | ADDED (ajout d'un éditeur) | COMPLEMENTARY (dépôt
    // de l'utilisateur affecté) — migration 20261107090000.
    origin: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "INITIAL" },
    uploadedBy: { type: DataTypes.UUID, allowNull: false },
  },
  { tableName: "calculation_note_documents", timestamps: true }
);

module.exports = CalculationNoteDocument;
