const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PorPromeshProcessControl = sequelize.define(
  "PorPromeshProcessControl",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    porPromeshId: { type: DataTypes.UUID, allowNull: false },

    bloc: { type: DataTypes.STRING(50), allowNull: false },
    parametre: { type: DataTypes.STRING(255), allowNull: true },
    valeurP1: { type: DataTypes.STRING(50), allowNull: true },
    corP1: { type: DataTypes.BOOLEAN, allowNull: true },
    valeurP2: { type: DataTypes.STRING(50), allowNull: true },
    corP2: { type: DataTypes.BOOLEAN, allowNull: true },
  },
  {
    tableName: "por_promesh_process_control",
    timestamps: true,
    indexes: [{ fields: ["porPromeshId"] }],
  }
);

module.exports = PorPromeshProcessControl;
