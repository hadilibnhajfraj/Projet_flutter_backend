"use strict";
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Journal des tentatives de réinitialisation de mot de passe (date, ip,
// email, succès/échec) — voir services/passwordResetLog.service.js. Sert
// aussi de source de vérité pour la limite "3 demandes/heure/utilisateur"
// (countRecentRequestsByEmail), fiable même après redémarrage serveur.
const PasswordResetLog = sequelize.define(
  "PasswordResetLog",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    email: { type: DataTypes.STRING(200), allowNull: false },
    ip: { type: DataTypes.STRING(64), allowNull: true },

    action: {
      type: DataTypes.ENUM("requested", "validated", "completed"),
      allowNull: false,
    },
    success: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Ex. "sent", "user_not_found", "rate_limited_email", "rate_limited_ip",
    // "expired", "invalid", "weak_password", "mismatch".
    reason: { type: DataTypes.STRING(64), allowNull: true },
  },
  {
    tableName: "password_reset_logs",
    timestamps: true,
    indexes: [{ fields: ["email", "createdAt"] }, { fields: ["ip", "createdAt"] }],
  }
);

module.exports = PasswordResetLog;
