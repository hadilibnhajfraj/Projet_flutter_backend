const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContactRelance = sequelize.define(
  "CommercialContactRelance",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    commercialContactId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    dateRelance: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },

    heureRelance: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },

    commentaire: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    statutRelance: {
      type: DataTypes.ENUM("planifiee", "faite", "annulee"),
      allowNull: false,
      defaultValue: "planifiee",
    },

    // 🔥 IMPORTANT
    emailSent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    // ── Automatisation Follow-up (commercial sélectionné, calendrier,
    // notifications, WhatsApp, rappels) ────────────────────────────────
    commercialId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    commercialName: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    commercialEmail: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    calendarEventId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    notificationSent: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    whatsappSent: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Dernier seuil de rappel envoyé par le cron : null | "24h" | "1h" | "15m"
    lastReminderSent: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },

    // ── Google Calendar (best-effort, voir googleCalendar.service.js) ──
    googleEventId: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    googleCalendarSynced: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    googleCalendarError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // ── Traçabilité des échecs best-effort (jamais bloquants) ──────────
    emailError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    whatsappError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "commercial_contact_relances",
    timestamps: true,
  }
);

module.exports = CommercialContactRelance;