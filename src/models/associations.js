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

const PipelineStage = require("./PipelineStage");
const ProjectActionType = require("./ProjectActionType");
const ProjectActivity = require("./ProjectActivity");
const ArchiveRequest = require("./ArchiveRequest");
const ArchiveRequestMessage = require("./ArchiveRequestMessage");

// ── PIPELINE STAGE <-> PROJECT ────────────────────────────

PipelineStage.hasMany(Project, {
  foreignKey: "pipelineStageId",
  as: "projects",
  onDelete: "SET NULL",
});

Project.belongsTo(PipelineStage, {
  foreignKey: "pipelineStageId",
  as: "stage",
});

// ── PIPELINE STAGE <-> ACTION TYPE ───────────────────────

PipelineStage.hasMany(ProjectActionType, {
  foreignKey: "linkedStageId",
  as: "actionTypes",
  onDelete: "SET NULL",
});

ProjectActionType.belongsTo(PipelineStage, {
  foreignKey: "linkedStageId",
  as: "linkedStage",
});

// ── ACTION TYPE <-> PROJECT ACTION ───────────────────────

ProjectActionType.hasMany(ProjectAction, {
  foreignKey: "actionTypeId",
  as: "actions",
});

ProjectAction.belongsTo(ProjectActionType, {
  foreignKey: "actionTypeId",
  as: "actionType",
});

// ── OWNER <-> PROJECT ─────────────────────────────────────

User.hasMany(Project, {
  foreignKey: "ownerId",
  as: "ownedProjects",
});

Project.belongsTo(User, {
  foreignKey: "ownerId",
  as: "owner",
});

// ── PROJECT ACTIVITIES ────────────────────────────────────

Project.hasMany(ProjectActivity, {
  foreignKey: "projectId",
  as: "activities",
  onDelete: "CASCADE",
});

ProjectActivity.belongsTo(Project, {
  foreignKey: "projectId",
  as: "project",
});

ProjectActivity.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
});

User.hasMany(ProjectActivity, {
  foreignKey: "userId",
  as: "projectActivities",
});

// ── COMPANY <-> PROJECT ───────────────────────────────────

Project.belongsTo(Company, { foreignKey: "companyId", as: "company" });
Company.hasMany(Project, { foreignKey: "companyId", as: "projects" });

Project.belongsTo(Engineer, { foreignKey: "engineerId", as: "engineer" });
Engineer.hasMany(Project, { foreignKey: "engineerId", as: "projects" });

Project.belongsTo(Architect, { foreignKey: "architectId", as: "architect" });
Architect.hasMany(Project, { foreignKey: "architectId", as: "projects" });

// ── USER <-> PROJECT (many-to-many) ───────────────────────

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

// ── PROJECT COMMENTS ──────────────────────────────────────

Project.hasMany(ProjectComment, {
  foreignKey: "projectId",
  onDelete: "CASCADE",
  as: "comments",
});

ProjectComment.belongsTo(Project, { foreignKey: "projectId" });

ProjectComment.belongsTo(User, { foreignKey: "authorId", as: "user" });

User.hasMany(ProjectComment, { foreignKey: "userId", as: "comments" });

ProjectComment.hasMany(ProjectComment, { foreignKey: "parentId", as: "replies" });
ProjectComment.belongsTo(ProjectComment, { foreignKey: "parentId", as: "parent" });

// ── NOTIFICATIONS ─────────────────────────────────────────

Notification.belongsTo(User, { as: "user", foreignKey: "userId" });
User.hasMany(Notification, { as: "notifications", foreignKey: "userId" });

// ── USER PROFILE ──────────────────────────────────────────

User.hasOne(UserProfile, { foreignKey: "userId", as: "profile", onDelete: "CASCADE" });
UserProfile.belongsTo(User, { foreignKey: "userId", as: "user" });

// ── PROJECT MEMBERS ───────────────────────────────────────

ProjectMember.belongsTo(Project, { foreignKey: "projectId" });
ProjectMember.belongsTo(User, { foreignKey: "userId" });
Project.hasMany(ProjectMember, { foreignKey: "projectId" });
User.hasMany(ProjectMember, { foreignKey: "userId" });

// ── PROJECT DEVIS ─────────────────────────────────────────

Project.hasMany(ProjectDevis, {
  foreignKey: "projectId",
  onDelete: "CASCADE",
  as: "devis",
});
ProjectDevis.belongsTo(Project, { foreignKey: "projectId" });

// ── PROJECT BON DE COMMANDE ───────────────────────────────

Project.hasMany(ProjectBonDeCommande, {
  foreignKey: "projectId",
  onDelete: "CASCADE",
  as: "bonsCommande",
});
ProjectBonDeCommande.belongsTo(Project, { foreignKey: "projectId" });

// ── TASKS ─────────────────────────────────────────────────

Task.belongsTo(User, { as: "creator", foreignKey: "createdBy" });
User.hasMany(Task, { as: "tasks", foreignKey: "createdBy" });

Task.belongsTo(Project, { as: "project", foreignKey: "projectId" });
Project.hasMany(Task, { as: "tasks", foreignKey: "projectId", onDelete: "CASCADE" });

// ── COMMERCIAL CONTACTS ───────────────────────────────────

CommercialContact.hasMany(CommercialContactProduct, {
  as: "produits",
  foreignKey: "commercialContactId",
  onDelete: "CASCADE",
});
CommercialContactProduct.belongsTo(CommercialContact, {
  as: "contact",
  foreignKey: "commercialContactId",
});

CommercialContact.hasMany(CommercialContactRelance, {
  as: "relances",
  foreignKey: "commercialContactId",
  onDelete: "CASCADE",
});
CommercialContactRelance.belongsTo(CommercialContact, {
  as: "contact",
  foreignKey: "commercialContactId",
});

CommercialContact.belongsTo(User, { as: "creator", foreignKey: "createdBy" });
User.hasMany(CommercialContact, { as: "commercialContacts", foreignKey: "createdBy" });

CommercialContactRelance.belongsTo(User, { as: "creator", foreignKey: "createdBy" });
User.hasMany(CommercialContactRelance, {
  as: "commercialContactRelances",
  foreignKey: "createdBy",
});

// ── PROJECT ACTIONS ───────────────────────────────────────

Project.hasMany(ProjectAction, {
  foreignKey: "projectId",
  as: "actions",
  onDelete: "CASCADE",
});
ProjectAction.belongsTo(Project, { foreignKey: "projectId", as: "project" });

ProjectAction.belongsTo(User, { foreignKey: "createdBy", as: "creator" });
User.hasMany(ProjectAction, { foreignKey: "createdBy", as: "createdActions" });

// ── ACTION REMINDERS ──────────────────────────────────────

ProjectAction.hasMany(ProjectReminder, {
  foreignKey: "actionId",
  as: "reminders",
  onDelete: "CASCADE",
});
ProjectReminder.belongsTo(ProjectAction, { foreignKey: "actionId", as: "action" });
ProjectReminder.belongsTo(User, { as: "creator", foreignKey: "createdBy" });

Project.hasMany(ProjectReminder, {
  foreignKey: "projectId",
  as: "reminders",
  onDelete: "CASCADE",
});
ProjectReminder.belongsTo(Project, { foreignKey: "projectId" });

// ── COMMERCIAL CONTACT ACTIONS ────────────────────────────

CommercialContact.hasMany(CommercialContactAction, {
  foreignKey: "commercialContactId",
  as: "actions",
});
CommercialContactAction.belongsTo(CommercialContact, {
  foreignKey: "commercialContactId",
});

CommercialContactAction.hasMany(CommercialContactReminder, {
  foreignKey: "actionId",
  as: "reminders",
});
CommercialContactReminder.belongsTo(CommercialContactAction, { foreignKey: "actionId" });

CommercialContact.hasMany(CommercialContactProduct, {
  foreignKey: "commercialContactId",
  as: "products",
});

CommercialContact.hasMany(CommercialProject, {
  foreignKey: "commercialContactId",
  as: "projects",
});
CommercialProject.belongsTo(CommercialContact, {
  foreignKey: "commercialContactId",
  as: "contact",
});

// ── ARCHIVE REQUESTS ──────────────────────────────────────

Project.hasMany(ArchiveRequest, { foreignKey: "projectId", as: "archiveRequests", onDelete: "CASCADE" });
// alias "archiveProject" — unique to avoid collision with ProjectActivity/Task/ProjectAction's "project" alias
ArchiveRequest.belongsTo(Project, { foreignKey: "projectId", as: "archiveProject" });

User.hasMany(ArchiveRequest, { foreignKey: "userId", as: "userArchiveRequests" });
ArchiveRequest.belongsTo(User, { foreignKey: "userId", as: "requester" });

ArchiveRequest.belongsTo(User, { foreignKey: "adminId", as: "assignedAdmin" });
User.hasMany(ArchiveRequest, { foreignKey: "adminId", as: "assignedRequests" });

ArchiveRequest.hasMany(ArchiveRequestMessage, { foreignKey: "requestId", as: "messages", onDelete: "CASCADE" });
ArchiveRequestMessage.belongsTo(ArchiveRequest, { foreignKey: "requestId", as: "request" });
ArchiveRequestMessage.belongsTo(User, { foreignKey: "senderId", as: "sender" });
User.hasMany(ArchiveRequestMessage, { foreignKey: "senderId", as: "archiveRequestMessages" });

console.log("ARCHIVE ASSOCIATIONS LOADED");

// ── EXPORTS ───────────────────────────────────────────────

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
  CommercialProject,
  PipelineStage,
  ProjectActionType,
  ProjectActivity,
  ArchiveRequest,
  ArchiveRequestMessage,
};
