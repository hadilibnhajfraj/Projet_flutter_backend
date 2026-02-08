const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectMember = sequelize.define(
  "ProjectMember",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    role: { type: DataTypes.ENUM("viewer", "editor"), allowNull: false, defaultValue: "viewer" },
  },
  {
    tableName: "project_members",
    timestamps: true,
    indexes: [
      { fields: ["projectId"] },
      { fields: ["userId"] },
      { unique: true, fields: ["projectId", "userId"] },
    ],
  }
);

module.exports = ProjectMember;
