const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContactReminder = sequelize.define(
  "CommercialContactReminder",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },

    commercialContactId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    actionId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    dateRelance: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    tableName: "commercial_contact_reminders",
  }
);

module.exports = CommercialContactReminder;