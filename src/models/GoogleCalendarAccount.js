// models/GoogleCalendarAccount.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const GoogleCalendarAccount = sequelize.define(
  "GoogleCalendarAccount",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    userId: { type: DataTypes.UUID, allowNull: false, unique: true },

    googleEmail: { type: DataTypes.STRING(200), allowNull: true },

    // Tokens chiffrés (AES-256-GCM, voir utils/tokenCrypto.js) — jamais en clair.
    accessTokenEnc: { type: DataTypes.TEXT, allowNull: true },
    refreshTokenEnc: { type: DataTypes.TEXT, allowNull: true },
    accessTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    scope: { type: DataTypes.STRING(500), allowNull: true },

    // ── Canal push Google (events.watch) — sync entrante, voir
    // googleCalendarWatch.service.js. Tous nullable : un compte peut être
    // connecté sans canal actif (best-effort, cf. GOOGLE_CALENDAR_WEBHOOK_BASE_URL). ──
    watchChannelId: { type: DataTypes.STRING(200), allowNull: true },
    watchResourceId: { type: DataTypes.STRING(200), allowNull: true },
    watchExpiration: { type: DataTypes.DATE, allowNull: true },
    watchToken: { type: DataTypes.STRING(200), allowNull: true },
    nextSyncToken: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "google_calendar_accounts",
    timestamps: true,
    indexes: [{ unique: true, fields: ["userId"] }],
  }
);

module.exports = GoogleCalendarAccount;
