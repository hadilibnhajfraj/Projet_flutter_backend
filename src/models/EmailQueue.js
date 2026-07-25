"use strict";
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// File d'attente d'envoi d'email — voir services/emailQueue.service.js pour
// la logique de retry/backoff. Une ligne est créée AVANT la première
// tentative d'envoi (jamais après), donc le message est toujours récupérable
// même si le process redémarre pendant une série de tentatives.
const EmailQueue = sequelize.define(
  "EmailQueue",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    to: { type: DataTypes.STRING(200), allowNull: false },
    subject: { type: DataTypes.STRING(255), allowNull: false },
    text: { type: DataTypes.TEXT, allowNull: true },
    html: { type: DataTypes.TEXT, allowNull: true },

    // Ex: "password_reset" — catégorie fonctionnelle, sert au tri/audit et à
    // un futur écran de renvoi manuel (pas de FK).
    context: { type: DataTypes.STRING(50), allowNull: true },
    meta: { type: DataTypes.JSON, allowNull: true },

    // Colonne dédiée (en plus de meta.userId) — nécessaire pour une requête
    // fiable/indexée "job actif pour cet utilisateur" (voir
    // services/emailQueue.service.js `findActiveJob`, utilisé par le MFA
    // pour éviter les doublons d'envoi).
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },

    status: {
      type: DataTypes.ENUM("PENDING", "RETRYING", "SENT", "FAILED", "CANCELLED"),
      allowNull: false,
      defaultValue: "PENDING",
    },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: true },

    lastResponseCode: { type: DataTypes.INTEGER, allowNull: true },
    lastResponse: { type: DataTypes.STRING(500), allowNull: true },
    lastErrorMessage: { type: DataTypes.STRING(500), allowNull: true },
    lastAttemptAt: { type: DataTypes.DATE, allowNull: true },
    sentAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "email_queue",
    timestamps: true,
    indexes: [
      { fields: ["status"] },
      { fields: ["to", "createdAt"] },
      { fields: ["userId", "context", "status"] },
    ],
  }
);

module.exports = EmailQueue;
