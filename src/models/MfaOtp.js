"use strict";
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// OTP MFA (6 chiffres) — seul le hash (SHA-256) est stocké, jamais la valeur
// en clair. Une nouvelle demande crée une nouvelle ligne ; la précédente
// n'est plus utilisable dès qu'elle expire ou qu'une plus récente existe
// (voir mfa.service.js `resolveActiveOtp`, même esprit que resetPasswordTokenHash
// mais avec historique conservé pour l'audit).
const MfaOtp = sequelize.define(
  "MfaOtp",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },

    // Nullable : effacés après validation réussie (voir mfa.service.js
    // `verifyOtp`) — `consumedAt` seul suffit à exclure la ligne de toute
    // recherche d'OTP actif, le hash/l'expiration n'ont plus besoin d'exister.
    otpHash: { type: DataTypes.STRING(64), allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    consumedAt: { type: DataTypes.DATE, allowNull: true },

    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
  },
  {
    tableName: "mfa_otps",
    timestamps: true,
    indexes: [{ fields: ["userId", "createdAt"] }],
  }
);

module.exports = MfaOtp;
