"use strict";
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Une ligne = un événement Google Calendar, pour UN destinataire, pour UNE
// action/relance. Voir multiRecipientCalendarSync.service.js — remplace le
// concept "un seul googleEventId" par "un événement par destinataire".
const CalendarEventSync = sequelize.define(
  "CalendarEventSync",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    entityType: {
      type: DataTypes.ENUM("project_action", "commercial_contact_relance"),
      allowNull: false,
    },
    entityId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },

    // Calendrier CRM personnel de CE destinataire (table `tasks`) — voir
    // GET /tasks qui filtre par Task.createdBy = req.user.sub.
    taskId: { type: DataTypes.UUID, allowNull: true },

    googleEventId: { type: DataTypes.STRING(200), allowNull: true },
    googleEventLink: { type: DataTypes.STRING(500), allowNull: true },
    calendarId: { type: DataTypes.STRING(200), allowNull: true, defaultValue: "primary" },

    synced: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    error: { type: DataTypes.TEXT, allowNull: true },
    googleUpdatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "calendar_event_syncs",
    timestamps: true,
    indexes: [{ fields: ["entityType", "entityId"] }],
  }
);

module.exports = CalendarEventSync;
