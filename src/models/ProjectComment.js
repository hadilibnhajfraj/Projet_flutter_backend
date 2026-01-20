const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ProjectComment = sequelize.define(
  "ProjectComment",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },
    authorId: { type: DataTypes.UUID, allowNull: false },

    // ✅ commentaire ou réponse
    parentId: { type: DataTypes.UUID, allowNull: true },

    body: { type: DataTypes.TEXT, allowNull: false },
  },
  {
    tableName: "project_comments",
    timestamps: true,
    indexes: [
      { fields: ["projectId"] },
      { fields: ["parentId"] },
      { fields: ["authorId"] },
    ],
  }
);

module.exports = ProjectComment;
