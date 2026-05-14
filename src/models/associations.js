// models/associations.js

const User = require("./User");
const Project = require("./Project");
const Company = require("./Company");
const Engineer = require("./Engineer");
const Architect = require("./Architect");
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

const ProjectAction = require("./ProjectAction");
const ProjectReminder = require("./ProjectReminder");
const CommercialContactAction = require("./CommercialContactAction");
const CommercialContactReminder = require("./CommercialContactReminder");


const CommercialProject = require("./CommercialProject");
// ======================================================
// COMPANY <-> PROJECT
// ======================================================

Project.belongsTo(Company, {
  foreignKey: "companyId",
  as: "company",
});

Company.hasMany(Project, {
  foreignKey: "companyId",
  as: "projects",
});

Project.belongsTo(Engineer, {
  foreignKey: "engineerId",
  as: "engineer",
});

Engineer.hasMany(Project, {
  foreignKey: "engineerId",
  as: "projects",
});

Project.belongsTo(Architect, {
  foreignKey: "architectId",
  as: "architect",
});

Architect.hasMany(Project, {
  foreignKey: "architectId",
  as: "projects",
});

// ======================================================
// USER <-> PROJECT
// ======================================================

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

User.hasMany(UserProject, { foreignKey: "userId" });
Project.hasMany(UserProject, { foreignKey: "projectId" });

UserProject.belongsTo(User, { foreignKey: "userId" });
UserProject.belongsTo(Project, { foreignKey: "projectId" });


// ======================================================
// PROJECT COMMENTS
// ======================================================

Project.hasMany(ProjectComment, {
  foreignKey: "projectId",
  onDelete: "CASCADE",
  as: "comments",
});

ProjectComment.belongsTo(Project, {
  foreignKey: "projectId",
});

ProjectComment.belongsTo(User, {
  foreignKey: "authorId",
  as: "user",
});

User.hasMany(ProjectComment, {
  foreignKey: "userId",
  as: "comments",
});

// replies
ProjectComment.hasMany(ProjectComment, {
  foreignKey: "parentId",
  as: "replies",
});

ProjectComment.belongsTo(ProjectComment, {
  foreignKey: "parentId",
  as: "parent",
});


// ======================================================
// NOTIFICATIONS
// ======================================================

Notification.belongsTo(User, {
  as: "user",
  foreignKey: "userId",
});

User.hasMany(Notification, {
  as: "notifications",
  foreignKey: "userId",
});


// ======================================================
// USER PROFILE
// ======================================================

User.hasOne(UserProfile, {
  foreignKey: "userId",
  as: "profile",
  onDelete: "CASCADE",
});

UserProfile.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
});


// ======================================================
// PROJECT MEMBERS
// ======================================================

ProjectMember.belongsTo(Project, { foreignKey: "projectId" });
ProjectMember.belongsTo(User, { foreignKey: "userId" });

Project.hasMany(ProjectMember, { foreignKey: "projectId" });
User.hasMany(ProjectMember, { foreignKey: "userId" });


// ======================================================
// PROJECT DEVIS
// ======================================================

Project.hasMany(ProjectDevis, {
  foreignKey: "projectId",
  onDelete: "CASCADE",
  as: "devis",
});

ProjectDevis.belongsTo(Project, { foreignKey: "projectId" });


// ======================================================
// PROJECT BON DE COMMANDE
// ======================================================

Project.hasMany(ProjectBonDeCommande, {
  foreignKey: "projectId",
  onDelete: "CASCADE",
  as: "bonsCommande",
});

ProjectBonDeCommande.belongsTo(Project, { foreignKey: "projectId" });


// ======================================================
// TASKS
// ======================================================

Task.belongsTo(User, {
  as: "creator",
  foreignKey: "createdBy",
});

User.hasMany(Task, {
  as: "tasks",
  foreignKey: "createdBy",
});

Task.belongsTo(Project, {
  as: "project",
  foreignKey: "projectId",
});

Project.hasMany(Task, {
  as: "tasks",
  foreignKey: "projectId",
  onDelete: "CASCADE",
});


// ======================================================
// COMMERCIAL CONTACTS
// ======================================================

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


// ======================================================
// PROJECT ACTIONS (CRM Timeline)
// ======================================================

Project.hasMany(ProjectAction, {
  foreignKey: "projectId",
  as: "actions",
  onDelete: "CASCADE",
});

ProjectAction.belongsTo(Project, {
  foreignKey: "projectId",
  as: "project",
});


// ======================================================
// ACTION REMINDERS
// ======================================================

ProjectAction.hasMany(ProjectReminder, {
  foreignKey: "actionId",
  as: "reminders",
  onDelete: "CASCADE",
});

ProjectReminder.belongsTo(ProjectAction, {
  foreignKey: "actionId",
  as: "action",
});
ProjectReminder.belongsTo(User,{
  as:"creator",
  foreignKey:"createdBy"
})

// ======================================================
// PROJECT REMINDERS
// ======================================================

Project.hasMany(ProjectReminder, {
  foreignKey: "projectId",
  as: "reminders",
  onDelete: "CASCADE",
});

ProjectReminder.belongsTo(Project, {
  foreignKey: "projectId",
});

// Contact → Actions
CommercialContact.hasMany(CommercialContactAction, {
  foreignKey: "commercialContactId",
  as: "actions",
});

CommercialContactAction.belongsTo(CommercialContact, {
  foreignKey: "commercialContactId",
});

// Action → Reminder
CommercialContactAction.hasMany(CommercialContactReminder, {
  foreignKey: "actionId",
  as: "reminders",
});

CommercialContactReminder.belongsTo(CommercialContactAction, {
  foreignKey: "actionId",
});
// ======================================================
// EXPORT
// ======================================================
// 🔹 Contact → Produits
CommercialContact.hasMany(CommercialContactProduct, {
  foreignKey: "commercialContactId",
  as: "products",
});

// 🔹 Contact → Projets
CommercialContact.hasMany(CommercialProject, {
  foreignKey: "commercialContactId",
  as: "projects",
});

CommercialProject.belongsTo(CommercialContact, {
  foreignKey: "commercialContactId",
  as: "contact",
});
module.exports = {
  User,
  Project,
  Company,
  Engineer,
  Architect,
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
  ProjectAction,
  ProjectReminder,
  CommercialContactAction,
  CommercialContactReminder,
  CommercialProject
};
