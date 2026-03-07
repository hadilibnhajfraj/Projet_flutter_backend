// models/User.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    email: { type: DataTypes.STRING(200), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(200), allowNull: false },

    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

   role: {
  type: DataTypes.ENUM("user", "commercial", "accueil", "admin", "superadmin"),
  allowNull: false,
  defaultValue: "user",
},

    // models/User.js (extrait)
resetPasswordTokenHash: { type: DataTypes.STRING, allowNull: true },
resetPasswordExpiresAt: { type: DataTypes.DATE, allowNull: true },

  },
  {
    tableName: "users",
    timestamps: true,
    indexes: [{ unique: true, fields: ["email"] }],
  }
);

module.exports = User;
