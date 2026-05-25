const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectAction = sequelize.define(
  "ProjectAction",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    projectId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    // ── Dynamic action type (replaces typeAction ENUM) ────
    actionTypeId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "project_action_types", key: "id" },
      onDelete: "SET NULL",
    },

    commentaire: { type: DataTypes.TEXT, allowNull: true },

    dateAction: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },

    dateRelance: { type: DataTypes.DATE, allowNull: true },

    statut: {
      type: DataTypes.ENUM("A faire", "En cours", "Terminé"),
      defaultValue: "A faire",
    },

    fileUrl: { type: DataTypes.STRING, allowNull: true },

    createdBy: { type: DataTypes.UUID, allowNull: false },
  },
  {
    tableName: "project_actions",
    timestamps: true,
    indexes: [
      { fields: ["projectId"] },
      { fields: ["actionTypeId"] },
      { fields: ["dateAction"] },
      { fields: ["createdBy"] },
    ],
  }
);

module.exports = ProjectAction;
