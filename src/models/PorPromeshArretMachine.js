const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PorPromeshArretMachine = sequelize.define(
  "PorPromeshArretMachine",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    porPromeshId: { type: DataTypes.UUID, allowNull: false },

    tArret: { type: DataTypes.STRING(255), allowNull: true },
    observationMachine: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "por_promesh_arrets_machine",
    timestamps: true,
    indexes: [{ fields: ["porPromeshId"] }],
  }
);

module.exports = PorPromeshArretMachine;
