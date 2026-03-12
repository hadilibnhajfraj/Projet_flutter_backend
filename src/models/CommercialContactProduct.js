const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContactProduct = sequelize.define(
  "CommercialContactProduct",
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

    produit: {
      type: DataTypes.STRING(200),
      allowNull: false,
      defaultValue: "PROBAR",
    },

    qte: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: "commercial_contact_products",
    timestamps: true,
  }
);

module.exports = CommercialContactProduct;