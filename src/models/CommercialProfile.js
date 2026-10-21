"use strict";
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Profil commercial personnalisé ("Autre commercial") enregistré par un
// compte — voir POST /commercial-contacts/user-names. `nameKey` = nom
// normalisé (trim + minuscules) pour l'unicité par compte. N'a aucun lien
// avec le rôle ni les permissions de l'utilisateur : c'est uniquement un nom
// d'attribution commerciale (user_nom_custom des contacts/projets).
const CommercialProfile = sequelize.define(
  "CommercialProfile",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    nameKey: { type: DataTypes.STRING(120), allowNull: false },
  },
  {
    tableName: "commercial_profiles",
    timestamps: true,
    indexes: [{ unique: true, fields: ["userId", "nameKey"] }],
  }
);

module.exports = CommercialProfile;
