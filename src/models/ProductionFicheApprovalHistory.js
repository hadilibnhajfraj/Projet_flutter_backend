"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Historique de validation d'une fiche de production (PROMESH / PROBAR) :
// une ligne par soumission ou décision (fromStatus null = création), avec
// numéro de soumission, auteur, date et motif éventuel. Jamais modifié.
const ProductionFicheApprovalHistory = sequelize.define(
  "ProductionFicheApprovalHistory",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    ficheType: { type: DataTypes.STRING(20), allowNull: false },
    ficheId: { type: DataTypes.UUID, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    fromStatus: { type: DataTypes.STRING(20), allowNull: true },
    toStatus: { type: DataTypes.STRING(20), allowNull: false },
    changedBy: { type: DataTypes.UUID, allowNull: true },
    changedByEmail: { type: DataTypes.STRING(255), allowNull: true },
    comment: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "production_fiche_approval_histories",
    timestamps: true,
    indexes: [{ fields: ["ficheType", "ficheId", "createdAt"], name: "production_fiche_approval_histories_fiche" }],
  }
);

module.exports = ProductionFicheApprovalHistory;
