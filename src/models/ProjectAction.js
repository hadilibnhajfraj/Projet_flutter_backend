const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectAction = sequelize.define(
  "ProjectAction",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    projectId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    // ── Legacy action type string (NOT NULL in DB — always required) ──
   typeAction_legacy: {
  type: DataTypes.STRING(100),
  allowNull: false,
  defaultValue: "Visite",
  validate: {
    notEmpty: {
      msg: "typeAction_legacy cannot be empty",
    },
  },
},

    // ── Dynamic action type FK (new system, nullable for BC) ─────────
    actionTypeId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "project_action_types", key: "id" },
      onDelete: "SET NULL",
    },

    commentaire: { type: DataTypes.TEXT, allowNull: true },

    dateAction: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },

    dateRelance: { type: DataTypes.DATE, allowNull: true },

   statut: {
  type: DataTypes.ENUM(
    "A faire",
    "En cours",
    "Terminé",
    "Annulé"
  ),
  allowNull: false,
  defaultValue: "A faire",
},

    fileUrl: { type: DataTypes.STRING, allowNull: true },

    createdBy: { type: DataTypes.UUID, allowNull: false },

    // ── Calendrier CRM + Google (voir projectActionCalendarSync.service.js) ──
    priorite: {
      type: DataTypes.ENUM("basse", "normale", "haute", "urgente"),
      allowNull: false,
      defaultValue: "normale",
    },
    // Heure de fin de l'événement — début = dateRelance ?? dateAction,
    // fin = dateFin ?? début + 1h (voir projectActionCalendar.service.js).
    dateFin: { type: DataTypes.DATE, allowNull: true },
    // Task interne (calendrier CRM personnel du propriétaire du projet).
    calendarEventId: { type: DataTypes.UUID, allowNull: true },
    googleEventId: { type: DataTypes.STRING(200), allowNull: true },
    // Lien direct "Ouvrir dans Google Calendar" (event.htmlLink) et calendrier
    // ciblé (toujours "primary" aujourd'hui, mais stocké pour rester correct
    // si un calendrier CRM dédié est introduit plus tard — point 7).
    googleEventLink: { type: DataTypes.STRING(500), allowNull: true },
    googleCalendarId: { type: DataTypes.STRING(200), allowNull: true },
    googleCalendarSynced: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    googleCalendarError: { type: DataTypes.TEXT, allowNull: true },
    // Cache anti-boucle pour la sync entrante Google -> CRM (Phase B).
    googleUpdatedAt: { type: DataTypes.DATE, allowNull: true },
    // Dernier seuil de rappel envoyé : null | "24h" | "1h" | "15m"
    lastReminderSent: { type: DataTypes.STRING(10), allowNull: true },
  },
  {
    tableName: "project_actions",
    timestamps: true,
    indexes: [
      { fields: ["projectId"] },
      { fields: ["actionTypeId"] },
      { fields: ["dateAction"] },
      { fields: ["createdBy"] },
    ],
  }
);

module.exports = ProjectAction;
