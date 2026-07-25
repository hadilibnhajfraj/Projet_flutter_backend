const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PorPromeshAttachment = sequelize.define(
  "PorPromeshAttachment",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    porPromeshId: { type: DataTypes.UUID, allowNull: false },
    uploadedBy: { type: DataTypes.UUID, allowNull: false },

    fileName: { type: DataTypes.STRING(255), allowNull: false },
    fileUrl: { type: DataTypes.STRING(500), allowNull: false },
  },
  {
    tableName: "por_promesh_attachments",
    timestamps: true,
    indexes: [{ fields: ["porPromeshId"] }],
  }
);

module.exports = PorPromeshAttachment;
