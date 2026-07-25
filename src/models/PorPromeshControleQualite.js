const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PorPromeshControleQualite = sequelize.define(
  "PorPromeshControleQualite",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    porPromeshId: { type: DataTypes.UUID, allowNull: false },

    // Mesure toutes les 3h (06:00/09:00/12:00/15:00/18:00/21:00 par défaut,
    // lignes additionnelles libres) — texte libre, pas de contrainte TIME
    // (cf. migration 20260623100100 : un vrai TIME avait déjà été abandonné
    // une fois pour ce même tableau).
    heure: { type: DataTypes.STRING(20), allowNull: true },
    numeroPlaque: { type: DataTypes.STRING(100), allowNull: true },
    // `hauteur` supprimée — plus aucune trace dans le modèle/l'API/le front.
    maille: { type: DataTypes.STRING(50), allowNull: true },
    longueur: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    largeur: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    statutCOQ: { type: DataTypes.ENUM("C", "NC"), allowNull: true },
  },
  {
    tableName: "por_promesh_controles_qualite",
    timestamps: true,
    indexes: [{ fields: ["porPromeshId"] }],
  }
);

module.exports = PorPromeshControleQualite;
