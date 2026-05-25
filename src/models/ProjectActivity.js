const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectActivity = sequelize.define(
  "ProjectActivity",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    projectId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "projects", key: "id" },
      onDelete: "CASCADE",
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    type: {
      type: DataTypes.STRING(50),
      allowNull: false,
      // stage_change | file_upload | comment | relance | edit | action_created
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "project_activities",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["projectId"] },
      { fields: ["userId"] },
      { fields: ["type"] },
      { fields: ["createdAt"] },
    ],
  }
);

module.exports = ProjectActivity;
