// models/associations.js
const User = require("./User");
const Project = require("./Project");
const UserProject = require("./UserProject");
const ProjectComment = require("./ProjectComment");
const UserProfile = require("./UserProfile");
const Notification = require("./Notification");
const ProjectMember = require("./ProjectMember");
const ProjectDevis = require("./ProjectDevis");
const ProjectBonDeCommande = require("./ProjectBonDeCommande");
const Task = require("./Task");
const CommercialContact = require("./CommercialContact");
const CommercialContactProduct = require("./CommercialContactProduct");
const CommercialContactRelance = require("./CommercialContactRelance");

// =========================
// User <-> Project
// =========================
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

// accès direct aux liens
User.hasMany(UserProject, { foreignKey: "userId" });
Project.hasMany(UserProject, { foreignKey: "projectId" });
UserProject.belongsTo(User, { foreignKey: "userId" });
UserProject.belongsTo(Project, { foreignKey: "projectId" });

// =========================
// Project Comments
// =========================
Project.hasMany(ProjectComment, { foreignKey: "projectId", onDelete: "CASCADE" });
ProjectComment.belongsTo(Project, { foreignKey: "projectId" });

User.hasMany(ProjectComment, { foreignKey: "authorId" });
ProjectComment.belongsTo(User, { foreignKey: "authorId" });

// replies
ProjectComment.hasMany(ProjectComment, {
  foreignKey: "parentId",
  as: "replies",
});
ProjectComment.belongsTo(ProjectComment, {
  foreignKey: "parentId",
  as: "parent",
});

// =========================
// Notification
// =========================
Notification.belongsTo(User, { as: "user", foreignKey: "userId" });
User.hasMany(Notification, { as: "notifications", foreignKey: "userId" });

// =========================
// User Profile
// =========================
User.hasOne(UserProfile, {
  foreignKey: "userId",
  as: "profile",
  onDelete: "CASCADE",
});
UserProfile.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
});

// =========================
// Project Members
// =========================
ProjectMember.belongsTo(Project, { foreignKey: "projectId" });
ProjectMember.belongsTo(User, { foreignKey: "userId" });
Project.hasMany(ProjectMember, { foreignKey: "projectId" });
User.hasMany(ProjectMember, { foreignKey: "userId" });

// =========================
// Project Devis
// =========================
Project.hasMany(ProjectDevis, {
  foreignKey: "projectId",
  onDelete: "CASCADE",
});
ProjectDevis.belongsTo(Project, { foreignKey: "projectId" });

// =========================
// Project Bons de commande
// =========================
Project.hasMany(ProjectBonDeCommande, {
  foreignKey: "projectId",
  onDelete: "CASCADE",
});
ProjectBonDeCommande.belongsTo(Project, { foreignKey: "projectId" });

// =========================
// Tasks
// =========================
Task.belongsTo(User, { as: "creator", foreignKey: "createdBy" });
User.hasMany(Task, { as: "tasks", foreignKey: "createdBy" });

Task.belongsTo(Project, { as: "project", foreignKey: "projectId" });
Project.hasMany(Task, {
  as: "tasks",
  foreignKey: "projectId",
  onDelete: "CASCADE",
});

// =========================
// Commercial Contacts
// =========================

// Contact -> Products
CommercialContact.hasMany(CommercialContactProduct, {
  as: "produits",
  foreignKey: "commercialContactId",
  onDelete: "CASCADE",
});
CommercialContactProduct.belongsTo(CommercialContact, {
  as: "contact",
  foreignKey: "commercialContactId",
});

// Contact -> Relances
CommercialContact.hasMany(CommercialContactRelance, {
  as: "relances",
  foreignKey: "commercialContactId",
  onDelete: "CASCADE",
});
CommercialContactRelance.belongsTo(CommercialContact, {
  as: "contact",
  foreignKey: "commercialContactId",
});

// Contact -> Creator
CommercialContact.belongsTo(User, {
  as: "creator",
  foreignKey: "createdBy",
});
User.hasMany(CommercialContact, {
  as: "commercialContacts",
  foreignKey: "createdBy",
});

// Relance -> Creator
CommercialContactRelance.belongsTo(User, {
  as: "creator",
  foreignKey: "createdBy",
});
User.hasMany(CommercialContactRelance, {
  as: "commercialContactRelances",
  foreignKey: "createdBy",
});

module.exports = {
  User,
  Project,
  UserProject,
  ProjectComment,
  UserProfile,
  Notification,
  ProjectMember,
  ProjectDevis,
  ProjectBonDeCommande,
  Task,
  CommercialContact,
  CommercialContactProduct,
  CommercialContactRelance,
};