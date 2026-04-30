const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContactRelance = sequelize.define(
  "CommercialContactRelance",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    commercialContactId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    dateRelance: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },

    heureRelance: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },

    commentaire: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    statutRelance: {
      type: DataTypes.ENUM("planifiee", "faite", "annulee"),
      allowNull: false,
      defaultValue: "planifiee",
    },

    // 🔥 IMPORTANT
    emailSent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    tableName: "commercial_contact_relances",
    timestamps: true,
  }
);

module.exports = CommercialContactRelance;