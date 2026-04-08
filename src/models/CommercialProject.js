const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialProject = sequelize.define(
  "CommercialProject",
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

    nomProjet: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },

    localisation: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    typeProjet: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },

    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "commercial_projects",
    timestamps: true,
  }
);

module.exports = CommercialProject;