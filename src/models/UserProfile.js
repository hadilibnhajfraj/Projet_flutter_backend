// models/UserProfile.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const UserProfile = sequelize.define(
  "UserProfile",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // ✅ FK vers User
    userId: { type: DataTypes.UUID, allowNull: false, unique: true },

    // ✅ champs front
    name: { type: DataTypes.STRING(200), allowNull: true },
    designation: { type: DataTypes.STRING(200), allowNull: true },

    birthday: { type: DataTypes.STRING(50), allowNull: true }, // tu peux mettre DATEONLY si tu veux
    phone: { type: DataTypes.STRING(50), allowNull: true },

    country: { type: DataTypes.STRING(120), allowNull: true },
    state: { type: DataTypes.STRING(120), allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: true },

    about: { type: DataTypes.TEXT, allowNull: true },

    // ✅ avatar
    avatarUrl: { type: DataTypes.STRING(500), allowNull: true }, // exemple: /uploads/avatars/xxx.png
  },
  {
    tableName: "user_profiles",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["userId"] },
    ],
  }
);

module.exports = UserProfile;
