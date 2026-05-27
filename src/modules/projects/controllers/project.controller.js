const svc = require("../services/project.service");
const projectRepo = require("../repositories/project.repository");
const ProjectAction = require("../../../models/ProjectAction");
const ProjectActionType = require("../../../models/ProjectActionType");
const ProjectReminder = require("../../../models/ProjectReminder");
const ProjectActivity = require("../../../models/ProjectActivity");
const ProjectComment = require("../../../models/ProjectComment");
const Project = require("../../../models/Project");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

const ADMIN_ROLES = ["admin", "superadmin"];

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error("Project error:", err);
  res.status(status).json({ message: err.message || "Internal server error" });
}

// ── Access guard ──────────────────────────────────────────
// For admins: always passes. For others: checks project exists then verifies ownership.

async function assertAccess(projectId, req, res) {
  if (ADMIN_ROLES.includes(req.user?.role)) return true;
  const project = await Project.findOne({
    where: { id: projectId },
    attributes: ["id", "ownerId"],
  });
  if (!project) {
    res.status(404).json({ message: "Project not found" });
    return false;
  }
  if (project.ownerId !== req.user?.sub) {
    res.status(403).json({ message: "Forbidden: not project owner" });
    return false;
  }
  return true;
}

// ── Shared owner include for User sub-queries ─────────────

const USER_WITH_PROFILE_INCLUDE = {
  model: User,
  attributes: ["id", "email"],
  include: [
    { model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false },
  ],
  required: false,
};

// ── Activity type → display metadata ─────────────────────

const ACTIVITY_META = {
  stage_change:   { icon: "git-branch",     color: "#3b82f6", title: "Changement de stage" },
  file_upload:    { icon: "paperclip",      color: "#6b7280", title: "Fichier ajouté" },
  comment:        { icon: "message-circle", color: "#10b981", title: "Commentaire" },
  relance:        { icon: "bell",           color: "#f59e0b", title: "Relance" },
  edit:           { icon: "edit-2",         color: "#8b5cf6", title: "Modification" },
  action_created: { icon: "zap",            color: "#ef4444", title: "Action créée" },
};

function toActivityEvent(act) {
  const a = act.toJSON ? act.toJSON() : act;
  const meta = ACTIVITY_META[a.type] || { icon: "activity", color: "#6b7280", title: a.type };
  const u = a.user;
  const profile = u?.profile || {};
  return {
    id: a.id,
    type: a.type,
    source: "activity",
    title: meta.title,
    commentaire: a.message || null,
    icon: meta.icon,
    color: meta.color,
    date: a.createdAt,
    metadata: a.metadata || null,
    user: u
      ? { id: u.id, name: profile.name || u.email || "Utilisateur", avatar: profile.avatarUrl || null }
      : null,
    reminder: null,
    attachment: null,
  };
}

function toActionEvent(action) {
  const a = action.toJSON ? action.toJSON() : action;
  const at = a.actionType;
  const creator = a.creator;
  const creatorProfile = creator?.profile || {};

  const now = new Date();
  const upcomingReminder = (a.reminders || [])
    .filter((r) => new Date(r.dateRelance) >= now)
    .sort((x, y) => new Date(x.dateRelance) - new Date(y.dateRelance))[0] || null;

  return {
    id: a.id,
    type: "action",
    source: "action",
    title: at?.name || a.typeAction_legacy || "Action",
    commentaire: a.commentaire || null,
    icon: at?.icon || "check-circle",
    color: at?.color || "#6b7280",
    statut: a.statut,
    date: a.dateAction,
    user: creator
      ? { id: creator.id, name: creatorProfile.name || creator.email || "Utilisateur", avatar: creatorProfile.avatarUrl || null }
      : null,
    reminder: upcomingReminder
      ? {
          id: upcomingReminder.id,
          dateRelance: upcomingReminder.dateRelance,
          daysRemaining: Math.ceil((new Date(upcomingReminder.dateRelance) - now) / 86400000),
          isLate: new Date(upcomingReminder.dateRelance) < now,
        }
      : null,
    attachment: a.fileUrl ? { url: a.fileUrl } : null,
    actionType: at ? { id: at.id, name: at.name, color: at.color, icon: at.icon } : null,
  };
}

function toNoteShape(n) {
  const note = n.toJSON ? n.toJSON() : n;
  const profile = note.user?.profile || {};
  return {
    id: note.id,
    body: note.body,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    author: note.user
      ? { id: note.user.id, name: profile.name || note.user.email || "Utilisateur", avatar: profile.avatarUrl || null }
      : null,
  };
}

// ── GET /projects/pipeline ────────────────────────────────

async function listProjects(req, res) {
  try {
    res.json(await svc.listProjects(req.query, req.user.sub));
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /projects/:id/move-stage ──────────────────────────

async function moveStage(req, res) {
  try {
    res.json({ data: await svc.moveStage(req.params.id, req.body.pipelineStageId, req.user.sub) });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /projects/:id/owner ───────────────────────────────

async function assignOwner(req, res) {
  try {
    res.json({ data: await svc.assignOwner(req.params.id, req.body.ownerId, req.user.sub) });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /projects/:id ─────────────────────────────────────

async function getProject(req, res) {
  try {
    const { id } = req.params;
    const project = await projectRepo.findByIdFull(id);
    if (!project) return res.status(404).json({ message: "Project not found" });

    if (project.isArchived && !ADMIN_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ message: "Projet archivé non accessible" });
    }
    if (!ADMIN_ROLES.includes(req.user?.role) && project.ownerId !== req.user?.sub) {
      return res.status(403).json({ message: "Forbidden: not project owner" });
    }

    const p = project.toJSON();
    const ownerProfile = p.owner?.profile || {};
    const lastAction = p.actions?.[0] ?? null;

    const visitDateISO = lastAction?.dateAction ? new Date(lastAction.dateAction).toISOString() : null;

    const response = {
      ...p,
      title: p.nomProjet || p.comptoir || null,
      owner: p.owner
        ? { id: p.owner.id, email: p.owner.email, fullName: ownerProfile.name || p.owner.email || null, avatarUrl: ownerProfile.avatarUrl || null }
        : null,
      // Dates — both keys so Flutter can use either
      dateDemarrage: p.dateDemarrage ?? null,
      startDate:     p.dateDemarrage ?? null,
      lastAction,
      nextAction:    lastAction?.typeAction_legacy ?? null,
      nextActionId:  lastAction?.actionTypeId ?? null,
      visitDate:     visitDateISO,
      dateVisite:    visitDateISO,
    };

    console.log("[PROJECT EDIT]", {
      id: p.id,
      dateDemarrage: response.dateDemarrage,
      startDate:     response.startDate,
      nextAction:    response.nextAction,
      nextActionId:  response.nextActionId,
      visitDate:     response.visitDate,
    });

    res.json(response);
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /projects/:id/timeline (unified) ─────────────────
// Merges ProjectActivity (system log) + ProjectAction (CRM actions) sorted by date DESC.

async function getTimeline(req, res) {
  try {
    const id = req.params.id || req.params.projectId;
    if (!await assertAccess(id, req, res)) return;

    const [activities, actions] = await Promise.all([
      ProjectActivity.findAll({
        where: { projectId: id },
        include: [{ ...USER_WITH_PROFILE_INCLUDE, as: "user" }],
        order: [["createdAt", "DESC"]],
        limit: 100,
      }),
      ProjectAction.findAll({
        where: { projectId: id },
        include: [
          { model: ProjectActionType, as: "actionType", required: false },
          { model: ProjectReminder, as: "reminders", required: false },
          { ...USER_WITH_PROFILE_INCLUDE, as: "creator", foreignKey: "createdBy" },
        ],
        order: [["dateAction", "DESC"]],
        limit: 100,
      }),
    ]);

    const events = [
      ...activities.map(toActivityEvent),
      ...actions.map(toActionEvent),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ success: true, data: events });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /projects/:id/notes ───────────────────────────────

async function getNotes(req, res) {
  try {
    const { id } = req.params;
    if (!await assertAccess(id, req, res)) return;

    const notes = await ProjectComment.findAll({
      where: { projectId: id, parentId: null },
      include: [{ ...USER_WITH_PROFILE_INCLUDE, as: "user" }],
      order: [["createdAt", "DESC"]],
    });

    res.json({ success: true, data: notes.map(toNoteShape) });
  } catch (err) {
    handle(res, err);
  }
}

// ── POST /projects/:id/notes ──────────────────────────────

async function createNote(req, res) {
  try {
    const { id } = req.params;
    if (!await assertAccess(id, req, res)) return;

    const { body } = req.body;
    if (!body || !String(body).trim()) {
      return res.status(400).json({ message: "body is required" });
    }

    const note = await ProjectComment.create({
      projectId: id,
      authorId: req.user.sub,
      parentId: null,
      body: String(body).trim(),
    });

    res.status(201).json({ success: true, data: { id: note.id, body: note.body, createdAt: note.createdAt } });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /projects/:id/full ────────────────────────────────
// Comprehensive snapshot: project + notes + reminders + recent system activities.

async function getProjectFull(req, res) {
  try {
    const { id } = req.params;
    const project = await projectRepo.findByIdFull(id);
    if (!project) return res.status(404).json({ message: "Project not found" });

    if (project.isArchived && !ADMIN_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ message: "Projet archivé non accessible" });
    }
    if (!ADMIN_ROLES.includes(req.user?.role) && project.ownerId !== req.user?.sub) {
      return res.status(403).json({ message: "Forbidden: not project owner" });
    }

    const now = new Date();

    const [notes, reminders, recentActivities] = await Promise.all([
      ProjectComment.findAll({
        where: { projectId: id, parentId: null },
        include: [{ ...USER_WITH_PROFILE_INCLUDE, as: "user" }],
        order: [["createdAt", "DESC"]],
        limit: 10,
      }),
      ProjectReminder.findAll({
        where: { projectId: id },
        order: [["dateRelance", "ASC"]],
      }),
      ProjectActivity.findAll({
        where: { projectId: id },
        include: [{ ...USER_WITH_PROFILE_INCLUDE, as: "user" }],
        order: [["createdAt", "DESC"]],
        limit: 20,
      }),
    ]);

    const enrichedReminders = reminders.map((r) => {
      const rj = r.toJSON ? r.toJSON() : r;
      const isLate = new Date(rj.dateRelance) < now;
      const daysRemaining = Math.ceil((new Date(rj.dateRelance) - now) / 86400000);
      return { ...rj, daysRemaining, isLate };
    });

    const p = project.toJSON();
    const ownerProfile = p.owner?.profile || {};

    res.json({
      success: true,
      data: {
        project: {
          ...p,
          title: p.nomProjet || p.comptoir || null,
          owner: p.owner
            ? { id: p.owner.id, email: p.owner.email, fullName: ownerProfile.name || p.owner.email || null, avatarUrl: ownerProfile.avatarUrl || null }
            : null,
        },
        notes: notes.map(toNoteShape),
        reminders: {
          upcoming: enrichedReminders.filter((r) => !r.isLate),
          late: enrichedReminders.filter((r) => r.isLate),
          total: reminders.length,
        },
        recentActivities: recentActivities.map(toActivityEvent),
      },
    });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = {
  listProjects,
  moveStage,
  assignOwner,
  getProject,
  getTimeline,
  getNotes,
  createNote,
  getProjectFull,
};
