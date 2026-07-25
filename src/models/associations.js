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
const MaintenanceRequest = require("./MaintenanceRequest");
const MaintenanceRequestComment = require("./MaintenanceRequestComment");
const MaintenanceRequestActivity = require("./MaintenanceRequestActivity");

const PorPromesh = require("./PorPromesh");
const PorPromeshControleQualite = require("./PorPromeshControleQualite");
const PorPromeshArretMachine = require("./PorPromeshArretMachine");
const PorPromeshConsommation = require("./PorPromeshConsommation");
const PorPromeshProcessControl = require("./PorPromeshProcessControl");
const PorPromeshAttachment = require("./PorPromeshAttachment");
const PorPromeshNonConformite = require("./PorPromeshNonConformite");
const IndustrialRecord = require("./IndustrialRecord");
const MaintenanceActivity = require("./MaintenanceActivity");
const HrRequest = require("./HrRequest");
const HrRequestActivity = require("./HrRequestActivity");
const RecuperableFiche = require("./RecuperableFiche");
const RecuperableLigne = require("./RecuperableLigne");
const GoogleCalendarAccount = require("./GoogleCalendarAccount");
const CommercialContactStatusHistory = require("./CommercialContactStatusHistory");

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

// Rattachement direct contact <-> commercial (affectation persistante,
// distincte de commercial_contact_relances.commercialId).
CommercialContact.belongsTo(User, { as: "commercial", foreignKey: "commercialId" });
User.hasMany(CommercialContact, { as: "assignedContacts", foreignKey: "commercialId" });

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

// ── HISTORIQUE DES STATUTS (statut + pipelineStage, append-only) ─────────

CommercialContact.hasMany(CommercialContactStatusHistory, {
  foreignKey: "commercialContactId",
  as: "statusHistory",
  onDelete: "CASCADE",
});
CommercialContactStatusHistory.belongsTo(CommercialContact, {
  foreignKey: "commercialContactId",
});
CommercialContactStatusHistory.belongsTo(User, {
  foreignKey: "changedBy",
  as: "changedByUser",
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

// ── MAINTENANCE REQUESTS (Demandes > Maintenance) ────────
// Module indépendant de IndustrialRecord/MaintenanceActivity (PRODUCTION >
// MAINTENANCE) — table et modèles dédiés, aucune association croisée.

User.hasMany(MaintenanceRequest, { foreignKey: "userId", as: "maintenanceRequests" });
MaintenanceRequest.belongsTo(User, { foreignKey: "userId", as: "requester" });

MaintenanceRequest.belongsTo(User, { foreignKey: "technicianId", as: "technician" });
User.hasMany(MaintenanceRequest, { foreignKey: "technicianId", as: "assignedMaintenanceRequests" });

MaintenanceRequest.belongsTo(User, { foreignKey: "acceptedBy", as: "acceptedByUser" });
MaintenanceRequest.belongsTo(User, { foreignKey: "rejectedBy", as: "rejectedByUser" });
MaintenanceRequest.belongsTo(User, { foreignKey: "completedBy", as: "completedByUser" });

MaintenanceRequest.hasMany(MaintenanceRequestComment, { foreignKey: "requestId", as: "comments", onDelete: "CASCADE" });
MaintenanceRequestComment.belongsTo(MaintenanceRequest, { foreignKey: "requestId", as: "request" });
MaintenanceRequestComment.belongsTo(User, { foreignKey: "senderId", as: "sender" });

MaintenanceRequest.hasMany(MaintenanceRequestActivity, { foreignKey: "requestId", as: "activities", onDelete: "CASCADE" });
MaintenanceRequestActivity.belongsTo(MaintenanceRequest, { foreignKey: "requestId", as: "request" });
MaintenanceRequestActivity.belongsTo(User, { foreignKey: "userId", as: "actor" });

console.log("MAINTENANCE REQUEST ASSOCIATIONS LOADED");

// ── POR PROMESH ───────────────────────────────────────────

PorPromesh.belongsTo(User, { foreignKey: "createdBy", as: "creator" });
User.hasMany(PorPromesh, { foreignKey: "createdBy", as: "porPromeshReports" });

PorPromesh.hasMany(PorPromeshControleQualite, {
  foreignKey: "porPromeshId",
  as: "controlesQualite",
  onDelete: "CASCADE",
});
PorPromeshControleQualite.belongsTo(PorPromesh, { foreignKey: "porPromeshId" });

PorPromesh.hasMany(PorPromeshArretMachine, {
  foreignKey: "porPromeshId",
  as: "arretsMachine",
  onDelete: "CASCADE",
});
PorPromeshArretMachine.belongsTo(PorPromesh, { foreignKey: "porPromeshId" });

PorPromesh.hasMany(PorPromeshConsommation, {
  foreignKey: "porPromeshId",
  as: "consommations",
  onDelete: "CASCADE",
});
PorPromeshConsommation.belongsTo(PorPromesh, { foreignKey: "porPromeshId" });

PorPromesh.hasMany(PorPromeshProcessControl, {
  foreignKey: "porPromeshId",
  as: "processControl",
  onDelete: "CASCADE",
});
PorPromeshProcessControl.belongsTo(PorPromesh, { foreignKey: "porPromeshId" });

PorPromesh.hasMany(PorPromeshAttachment, {
  foreignKey: "porPromeshId",
  as: "attachments",
  onDelete: "CASCADE",
});
PorPromeshAttachment.belongsTo(PorPromesh, { foreignKey: "porPromeshId" });
PorPromeshAttachment.belongsTo(User, { foreignKey: "uploadedBy", as: "uploader" });

PorPromesh.hasMany(PorPromeshNonConformite, {
  foreignKey: "porPromeshId",
  as: "nonConformites",
  onDelete: "CASCADE",
});
PorPromeshNonConformite.belongsTo(PorPromesh, { foreignKey: "porPromeshId" });

// ── INDUSTRIAL RECORDS (PROBAR / MÉLANGE / MAINTENANCE) ───

IndustrialRecord.belongsTo(User, { foreignKey: "createdBy", as: "creator" });
User.hasMany(IndustrialRecord, { foreignKey: "createdBy", as: "industrialRecords" });

IndustrialRecord.hasMany(MaintenanceActivity, { foreignKey: "industrialRecordId", as: "maintenanceActivities", onDelete: "CASCADE" });
MaintenanceActivity.belongsTo(IndustrialRecord, { foreignKey: "industrialRecordId", as: "record" });
MaintenanceActivity.belongsTo(User, { foreignKey: "userId", as: "user" });
User.hasMany(MaintenanceActivity, { foreignKey: "userId", as: "maintenanceActivities" });

// ── RH — DEMANDES (congé / autorisation de sortie) ────────

HrRequest.belongsTo(User, { foreignKey: "requestedBy", as: "employee" });
User.hasMany(HrRequest, { foreignKey: "requestedBy", as: "hrRequests" });

HrRequest.belongsTo(User, { foreignKey: "reviewedBy", as: "reviewedByUser" });
HrRequest.belongsTo(User, { foreignKey: "processedBy", as: "processedByUser" });

HrRequest.hasMany(HrRequestActivity, { foreignKey: "requestId", as: "activities", onDelete: "CASCADE" });
HrRequestActivity.belongsTo(HrRequest, { foreignKey: "requestId", as: "request" });
HrRequestActivity.belongsTo(User, { foreignKey: "userId", as: "actor" });

// ── RÉCUPÉRABLES (fiche → lignes) ─────────────────────────

RecuperableFiche.hasMany(RecuperableLigne, { foreignKey: "ficheId", as: "lignes", onDelete: "CASCADE" });
RecuperableLigne.belongsTo(RecuperableFiche, { foreignKey: "ficheId" });
RecuperableFiche.belongsTo(User, { foreignKey: "createdBy", as: "creator" });
User.hasMany(RecuperableFiche, { foreignKey: "createdBy", as: "recuperableFiches" });

// ── GOOGLE CALENDAR (comptes connectés) ───────────────────

User.hasOne(GoogleCalendarAccount, {
  foreignKey: "userId",
  as: "googleCalendarAccount",
  onDelete: "CASCADE",
});
GoogleCalendarAccount.belongsTo(User, { foreignKey: "userId", as: "user" });

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
  PorPromesh,
  PorPromeshControleQualite,
  PorPromeshArretMachine,
  PorPromeshConsommation,
  PorPromeshProcessControl,
  PorPromeshAttachment,
  PorPromeshNonConformite,
  IndustrialRecord,
  MaintenanceActivity,
  HrRequest,
  RecuperableFiche,
  RecuperableLigne,
  IndustrialRecord,
  GoogleCalendarAccount,
  CommercialContactStatusHistory,
};
