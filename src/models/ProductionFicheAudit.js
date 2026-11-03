"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Journal APPEND-ONLY des modifications (root admin) et suppressions des
// fiches PROBAR / PROMESH — migration 20261109090000. Jamais mis à jour ni
// supprimé : c'est la seule copie d'une fiche supprimée.
const ProductionFicheAudit = sequelize.define(
  "ProductionFicheAudit",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    ficheType: { type: DataTypes.STRING(10), allowNull: false }, // PROMESH | PROBAR
    ficheId: { type: DataTypes.UUID, allowNull: false },
    ficheNumber: { type: DataTypes.STRING(50), allowNull: true },
    action: { type: DataTypes.STRING(10), allowNull: false }, // UPDATE | DELETE
    userId: { type: DataTypes.UUID, allowNull: true },
    userEmail: { type: DataTypes.STRING(255), allowNull: true },
    userRole: { type: DataTypes.STRING(50), allowNull: true },
    lockOverride: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    changes: { type: DataTypes.JSONB, allowNull: true }, // { champ: { before, after } }
    snapshot: { type: DataTypes.JSONB, allowNull: true }, // fiche complète avant suppression
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "production_fiche_audit",
    timestamps: false,
  }
);

module.exports = ProductionFicheAudit;
