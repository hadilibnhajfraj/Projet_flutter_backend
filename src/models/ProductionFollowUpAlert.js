"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// "Production Follow-up" — suivi quotidien des journées de production SANS
// AUCUNE fiche (0 fiche créée pour la date, toute heure confondue) —
// COMPLÉMENTAIRE à production_compliance_alerts (qui contrôle une fenêtre
// horaire précise et reste totalement inchangé). Une ligne = une anomalie
// (production + date) ; §11 du ticket : une seule ligne par production+date
// (contrainte unique), jamais retraitée en double par un cron qui tourne
// plusieurs fois.
const ProductionFollowUpAlert = sequelize.define(
  "ProductionFollowUpAlert",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productionType: { type: DataTypes.STRING(20), allowNull: false }, // PROD1 | PROD2
    productionDate: { type: DataTypes.DATEONLY, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: true },
    userEmail: { type: DataTypes.STRING(255), allowNull: true },
    sheetsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // §14 — statut métier global (jamais une logique parallèle inventée).
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PENDING" }, // PENDING | EMAIL_SENT | RESOLVED | IGNORED

    // §11/§17 — suivi fin de l'envoi e-mail, séparé du statut métier :
    // un envoi qui échoue NE fait JAMAIS passer status à EMAIL_SENT (§17).
    emailError: { type: DataTypes.TEXT, allowNull: true },
    emailSentAt: { type: DataTypes.DATE, allowNull: true },
    lastEmailAttemptAt: { type: DataTypes.DATE, allowNull: true },
    retryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    recipients: { type: DataTypes.JSONB, allowNull: true },

    // §15 — régularisation automatique lorsqu'une fiche est créée après coup.
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    resolvedByFicheType: { type: DataTypes.STRING(20), allowNull: true },
    resolvedByFicheId: { type: DataTypes.UUID, allowNull: true },

    // Décision manuelle (Super Admin) de fermer une anomalie sans e-mail /
    // sans fiche (ex. faux positif confirmé) — jamais automatique.
    ignoredAt: { type: DataTypes.DATE, allowNull: true },
    ignoredBy: { type: DataTypes.UUID, allowNull: true },
    ignoredReason: { type: DataTypes.TEXT, allowNull: true },

    checkedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "production_follow_up_alerts", timestamps: true }
);

module.exports = ProductionFollowUpAlert;
