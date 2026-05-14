const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Engineer = sequelize.define(
  "Engineer",
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
    phone: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: {
        isEmail: true,
      },
    },
  },
  {
    tableName: "engineers",
    timestamps: true,
    indexes: [{ unique: true, fields: ["name"] }],
  }
);

module.exports = Engineer;
