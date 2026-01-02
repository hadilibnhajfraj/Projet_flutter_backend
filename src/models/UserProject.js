// models/UserProject.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const UserProject = sequelize.define(
  "UserProject",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    projectId: { type: DataTypes.UUID, allowNull: false },
    permission: {
      type: DataTypes.ENUM("viewer", "editor", "owner"),
      allowNull: false,
      defaultValue: "viewer",
    },
  },
  {
    tableName: "user_projects",
    timestamps: true,
    indexes: [{ unique: true, fields: ["userId", "projectId"] }],
  }
);

module.exports = UserProject;
