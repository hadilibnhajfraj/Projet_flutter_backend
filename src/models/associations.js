// models/associations.js
const User = require("./User");
const Project = require("./Project");
const UserProject = require("./UserProject");
const ProjectComment = require("./ProjectComment");
const UserProfile = require("./UserProfile");
const Notification = require("./Notification");
const ProjectMember = require("./ProjectMember");
User.belongsToMany(Project, {
  through: UserProject,
  foreignKey: "userId",
  otherKey: "projectId",
});

Project.belongsToMany(User, {
  through: UserProject,
  foreignKey: "projectId",
  otherKey: "userId",
});

// (optionnel) accès direct aux liens
User.hasMany(UserProject, { foreignKey: "userId" });
Project.hasMany(UserProject, { foreignKey: "projectId" });
UserProject.belongsTo(User, { foreignKey: "userId" });
UserProject.belongsTo(Project, { foreignKey: "projectId" });
Project.hasMany(ProjectComment, { foreignKey: "projectId" });
ProjectComment.belongsTo(Project, { foreignKey: "projectId" });
Notification.belongsTo(User, { as: "user", foreignKey: "userId" });

User.hasMany(ProjectComment, { foreignKey: "authorId" });
ProjectComment.belongsTo(User, { foreignKey: "authorId" });
User.hasOne(UserProfile, { foreignKey: "userId", as: "profile", onDelete: "CASCADE" });
UserProfile.belongsTo(User, { foreignKey: "userId", as: "user" });
// Members (optionnel mais recommandé)
ProjectMember.belongsTo(Project, { foreignKey: "projectId" });
ProjectMember.belongsTo(User, { foreignKey: "userId" });
Project.hasMany(ProjectMember, { foreignKey: "projectId" });
User.hasMany(ProjectMember, { foreignKey: "userId" });
// replies
ProjectComment.hasMany(ProjectComment, { foreignKey: "parentId", as: "replies" });
ProjectComment.belongsTo(ProjectComment, { foreignKey: "parentId", as: "parent" });
module.exports = { User, Project, UserProject, ProjectComment, UserProfile , Notification };
