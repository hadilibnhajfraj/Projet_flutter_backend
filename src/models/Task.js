const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Task = sequelize.define(
  "Task",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // ✅ RDV / suivi commercial
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },

    // ✅ on stocke date+heure ensemble (le plus propre)
    startAt: { type: DataTypes.DATE, allowNull: false },

  

    // ✅ qui a créé (commercial)
    createdBy: { type: DataTypes.UUID, allowNull: false },
  // ✅ NEW: task liée à un projet
    projectId: { type: DataTypes.UUID, allowNull: true }, // TEMPORAIRE
    // optionnel : état
    status: {
      type: DataTypes.ENUM("planned", "done", "canceled"),
      allowNull: false,
      defaultValue: "planned",
    },
  },
  { tableName: "tasks", timestamps: true }
);

module.exports = Task;