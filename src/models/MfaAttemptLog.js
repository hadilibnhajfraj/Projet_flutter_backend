"use strict";
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Journal des tentatives MFA (date, ip, email, succès/échec) — même pattern
// que PasswordResetLog (models/PasswordResetLog.js).
const MfaAttemptLog = sequelize.define(
  "MfaAttemptLog",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    email: { type: DataTypes.STRING(200), allowNull: false },
    ip: { type: DataTypes.STRING(64), allowNull: true },

    action: {
      type: DataTypes.ENUM(
        "otp_requested",
        "otp_verified",
        "otp_failed",
        "device_trusted",
        "device_rejected",
        "mfa_invalidated"
      ),
      allowNull: false,
    },
    success: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Ex. "sent", "user_not_found", "wrong_code", "expired", "max_attempts",
    // "new_ip", "new_browser", "new_device", "new_country", "password_changed".
    reason: { type: DataTypes.STRING(64), allowNull: true },
  },
  {
    tableName: "mfa_attempt_logs",
    timestamps: true,
    indexes: [{ fields: ["email", "createdAt"] }, { fields: ["userId", "createdAt"] }],
  }
);

module.exports = MfaAttemptLog;
