const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PorPromeshNonConformite = sequelize.define(
  "PorPromeshNonConformite",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    porPromeshId: { type: DataTypes.UUID, allowNull: false },

    typeNC: { type: DataTypes.STRING(255), allowNull: true },
    gravite: { type: DataTypes.ENUM("faible", "moyenne", "critique"), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    photoUrl: { type: DataTypes.STRING(500), allowNull: true },
  },
  {
    tableName: "por_promesh_non_conformites",
    timestamps: true,
    indexes: [{ fields: ["porPromeshId"] }],
  }
);

module.exports = PorPromeshNonConformite;
