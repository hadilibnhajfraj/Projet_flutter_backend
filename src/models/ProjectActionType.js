const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectActionType = sequelize.define(
  "ProjectActionType",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    color: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: "#6366f1",
    },
    icon: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    linkedStageId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "pipeline_stages", key: "id" },
      onDelete: "SET NULL",
    },
  },
  {
    tableName: "project_action_types",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["name"] },
      { fields: ["linkedStageId"] },
    ],
  }
);

module.exports = ProjectActionType;
