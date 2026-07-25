"use strict";
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Appareils de confiance ("Faire confiance à cet appareil pendant 30 jours").
// Seul le hash (SHA-256) du device token signé est stocké — le token en clair
// n'est remis au client qu'une seule fois, à la création (même logique que
// resetPasswordTokenHash). ip/browser/country = contexte au moment où la
// confiance a été accordée ; comparés à chaque connexion (voir mfa.service.js
// `isDeviceStillTrusted`) pour révoquer implicitement la confiance si l'un
// de ces signaux a changé, même si le token lui-même est encore valide.
const TrustedDevice = sequelize.define(
  "TrustedDevice",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },

    deviceId: { type: DataTypes.STRING(100), allowNull: false },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false },
    deviceName: { type: DataTypes.STRING(150), allowNull: true },

    ip: { type: DataTypes.STRING(64), allowNull: true },
    browser: { type: DataTypes.STRING(100), allowNull: true },
    country: { type: DataTypes.STRING(2), allowNull: true },

    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    lastUsedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "trusted_devices",
    timestamps: true,
    indexes: [{ fields: ["userId", "deviceId"] }],
  }
);

module.exports = TrustedDevice;
