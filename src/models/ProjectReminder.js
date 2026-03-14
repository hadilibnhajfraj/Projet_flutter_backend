const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectReminder = sequelize.define(
  "ProjectReminder",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },

    projectId: {
      type: DataTypes.UUID,
      allowNull: false
    },

    actionId: {
      type: DataTypes.UUID,
      allowNull: false
    },

    message: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    dateRelance: {
      type: DataTypes.DATE,
      allowNull: false
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: false
    }
  },
  {
    tableName: "project_reminders"
  }
);

module.exports = ProjectReminder;