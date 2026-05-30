const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Notification = sequelize.define(
  "Notification",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    type: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },

    title: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },

    message: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },

    // =========================
    // 🔥 RELATIONS FLEXIBLES
    // =========================

    projectId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    commentId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    commercialContactId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    relanceId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    // =========================
    // 🔥 STATUS
    // =========================
    isRead: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: "notifications",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["isRead"] },
      { fields: ["projectId"] },
      { fields: ["commercialContactId"] },
      { fields: ["relanceId"] },
    ],
  }
);

module.exports = Notification;