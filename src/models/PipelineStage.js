const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PipelineStage = sequelize.define(
  "PipelineStage",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(120),
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
    position: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isWonStage: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isLostStage: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    autoCreateAction: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isCustom: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    tableName: "pipeline_stages",
    timestamps: true,
    paranoid: true,          // soft-delete via deletedAt
    indexes: [
      { unique: true, fields: ["name"], where: { deletedAt: null } },
      { fields: ["position"] },
      { fields: ["isWonStage"] },
      { fields: ["isLostStage"] },
      { fields: ["createdBy"] },
    ],
  }
);

module.exports = PipelineStage;
