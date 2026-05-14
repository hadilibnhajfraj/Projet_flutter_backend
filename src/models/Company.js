const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Company = sequelize.define(
  "Company",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(200),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true,
        len: [1, 200],
      },
    },
  },
  {
    tableName: "companies",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["name"] },
    ],
  }
);

module.exports = Company;
