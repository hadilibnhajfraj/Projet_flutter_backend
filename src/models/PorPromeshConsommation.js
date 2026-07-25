const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PorPromeshConsommation = sequelize.define(
  "PorPromeshConsommation",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    porPromeshId: { type: DataTypes.UUID, allowNull: false },

    designationArticle: { type: DataTypes.STRING(255), allowNull: true },
    metrage: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    observation: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "por_promesh_consommations",
    timestamps: true,
    indexes: [{ fields: ["porPromeshId"] }],
  }
);

module.exports = PorPromeshConsommation;
