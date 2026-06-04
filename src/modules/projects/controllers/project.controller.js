const svc = require("../services/project.service");
const projectRepo = require("../repositories/project.repository");
const { computeCompletion } = require("../utils/project.completion");
const ProjectAction = require("../../../models/ProjectAction");
const ProjectActionType = require("../../../models/ProjectActionType");
const ProjectReminder = require("../../../models/ProjectReminder");
const ProjectActivity = require("../../../models/ProjectActivity");
const ProjectComment = require("../../../models/ProjectComment");
const Project = require("../../../models/Project");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
const { sequelize } = require("../../../db");
require("../../../models/associations");

const ADMIN_ROLES = ["admin", "superadmin"];

// ── Field definitions for GET /projects/missing-fields ───────────────────────

const VALID_FIELDS = ["bureauControle", "architecte", "ingenieur", "telephone", "adresse"];

// SQL fragment that evaluates to TRUE when the field is considered "missing"
const FIELD_MISSING_SQL = {
  bureauControle: `("bureauControle" IS NULL OR TRIM("bureauControle") = '')`,
  architecte:     `("architecte"     IS NULL OR TRIM("architecte")     = '')`,
  ingenieur:      `("ingenieurResponsable" IS NULL OR TRIM("ingenieurResponsable") = '')`,
  // telephone: project has NO phone at all (every phone column is blank)
  telephone: `(
    ("telephoneIngenieur"  IS NULL OR TRIM("telephoneIngenieur")  = '') AND
    ("telephoneArchitecte" IS NULL OR TRIM("telephoneArchitecte") = '') AND
    ("telephoneComptoir"   IS NULL OR TRIM("telephoneComptoir")   = '') AND
    ("telephoneDallagiste" IS NULL OR TRIM("telephoneDallagiste") = '')
  )`,
  adresse: `("adresse" IS NULL OR TRIM("adresse") = '')`,
};

// JS predicate used to label each row after the DB query
const FIELD_MISSING_JS = {
  bureauControle: (r) => !r.bureauControle       || String(r.bureauControle).trim()       === "",
  architecte:     (r) => !r.architecte           || String(r.architecte).trim()           === "",
  ingenieur:      (r) => !r.ingenieurResponsable || String(r.ingenieurResponsable).trim() === "",
  telephone:      (r) =>
    (!r.telephoneIngenieur  || String(r.telephoneIngenieur).trim()  === "") &&
    (!r.telephoneArchitecte || String(r.telephoneArchitecte).trim() === "") &&
    (!r.telephoneComptoir   || String(r.telephoneComptoir).trim()   === "") &&
    (!r.telephoneDallagiste || String(r.telephoneDallagiste).trim() === ""),
  adresse: (r) => !r.adresse || String(r.adresse).trim() === "",
};

const SORTABLE_FIELDS = ["createdAt", "nomProjet", "statut", "updatedAt", "projectModele"];

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
    console.log("=== USER FILTER ===");
    console.log(req.query.userId);
    const result = await svc.listProjects(req.query, req.user.sub);
    console.log("PROJECT COUNT AFTER FILTER");
    console.log(result.stats?.total);
    res.json(result);
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

// ── Status lists per project model ───────────────────────

const PROJECT_STATUSES = [
  "Identification",
  "Prospect",
  "Contacté",
  "Visite",
  "Plan technique",
  "Echantillonnage",
  "Devis envoyé",
  "Négociation",
  "Gagné",
  "Perdu",
  "Fidélisation",
];

const REVENDEUR_STATUSES = ["Prospect", "Offre", "Actif", "Raté"];

function getAvailableStatuses(projectModele) {
  switch ((projectModele || "").toLowerCase()) {
    case "revendeur":   return REVENDEUR_STATUSES;
    case "applicateur": return [];
    default:            return PROJECT_STATUSES;
  }
}

// ── PUT /projects/:id/status ──────────────────────────────

async function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { statut } = req.body;

    if (!statut) {
      return res.status(400).json({ success: false, message: "statut est requis" });
    }

    const project = await Project.findByPk(id, {
      attributes: ["id", "ownerId", "statut", "projectModele"],
    });
    if (!project) return res.status(404).json({ success: false, message: "Projet introuvable" });

    if (!ADMIN_ROLES.includes(req.user?.role) && project.ownerId !== req.user?.sub) {
      return res.status(403).json({ success: false, message: "Forbidden: not project owner" });
    }

    const allowed = getAvailableStatuses((project.projectModele || "").toLowerCase().trim());
    console.log("PROJECT MODELE =", project.projectModele, "| STATUT RECU =", statut, "| ALLOWED STATUSES =", allowed);
    if (allowed.length > 0 && !allowed.includes(statut)) {
      return res.status(400).json({
        success: false,
        message: `Statut invalide pour ${project.projectModele}. Valeurs acceptées : ${allowed.join(", ")}`,
        allowedStatuses: allowed,
      });
    }

    const oldStatut = project.statut;
    await project.update({ statut: allowed.length === 0 ? null : statut });

    console.log("[UPDATE STATUS]", {
      id,
      projectModele: project.projectModele,
      oldStatut,
      newStatut: statut,
    });

    res.json({
      success: true,
      message: "Statut mis à jour",
      data: { id, statut, projectModele: project.projectModele },
      allowedStatuses: allowed,
    });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /projects/statuses ────────────────────────────────
// Returns the status list for a given projectModele (?projectModele=project|revendeur|applicateur)

function listStatuses(req, res) {
  const modele = req.query.projectModele || "project";
  res.json({ success: true, projectModele: modele, statuses: getAvailableStatuses(modele) });
}

// ── Relance status helper ─────────────────────────────────

function getRelanceStatus(nextRelanceDate) {
  if (!nextRelanceDate) return "none";
  return new Date(nextRelanceDate) < new Date() ? "late" : "ok";
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
      relanceStatus: getRelanceStatus(p.nextRelanceDate),
      ...computeCompletion(p),
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
          relanceStatus: getRelanceStatus(p.nextRelanceDate),
          ...computeCompletion(p),
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

// ── PUT /projects/:id/archive ─────────────────────────────

async function archiveProject(req, res) {
  try {
    const { id } = req.params;
    if (!await assertAccess(id, req, res)) return;

    const project = await Project.findByPk(id, {
      attributes: ["id", "isArchived", "ownerId"],
    });
    if (!project) return res.status(404).json({ message: "Projet introuvable" });

    const { reason } = req.body;

    // archiveReason is required for voluntary archives so we can distinguish them
    // from auto-archives and audit the history properly
    const archiveReason = (reason || "").trim() || "Archivé manuellement";

    console.log("ARCHIVE PROJECT");
    console.log("PROJECT_ID",     id);
    console.log("USER_ID",        req.user?.sub);
    console.log("ARCHIVE_REASON", archiveReason);
    console.log("DATE",           new Date().toISOString());

    await project.update({
      isArchived:    true,
      archivedAt:    new Date(),
      archiveReason,
    });

    res.json({
      success: true,
      message: "Projet archivé",
      data: { id, isArchived: true, archiveReason },
    });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /projects/:id/unarchive ───────────────────────────

async function unarchiveProject(req, res) {
  try {
    const { id } = req.params;
    if (!await assertAccess(id, req, res)) return;

    const project = await Project.findByPk(id, { attributes: ["id", "ownerId"] });
    if (!project) return res.status(404).json({ message: "Projet introuvable" });

    await project.update({
      isArchived: false,
      archivedAt: null,
      archiveReason: null,
    });

    res.json({ success: true, message: "Projet désarchivé", data: { id, isArchived: false } });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /projects/missing-fields ─────────────────────────────────────────────
// Returns projects where one or more specified fields are NULL or empty.
// Query params:
//   field=bureauControle|architecte|ingenieur|telephone|adresse  (repeatable)
//   page, limit, sortBy, sortDir, search

async function getMissingFields(req, res) {
  try {
    const isAdmin = ADMIN_ROLES.includes(req.user?.role);
    const userId  = req.user.sub;

    // ── 1. Validate field params ──────────────────────────
    const rawFields = [].concat(req.query.field || []);
    const fields    = rawFields.filter((f) => VALID_FIELDS.includes(f));

    if (!fields.length) {
      return res.status(400).json({
        message: `Au moins un paramètre field est requis. Valeurs acceptées : ${VALID_FIELDS.join(", ")}`,
      });
    }

    // ── 2. Pagination ─────────────────────────────────────
    const page   = Math.max(parseInt(req.query.page)  || 1,  1);
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    // ── 3. Sorting (whitelist) ────────────────────────────
    const sortBy  = SORTABLE_FIELDS.includes(req.query.sortBy) ? req.query.sortBy : "createdAt";
    const sortDir = req.query.sortDir === "ASC" ? "ASC" : "DESC";

    // ── 4. Search ─────────────────────────────────────────
    const search = typeof req.query.search === "string" && req.query.search.trim()
      ? req.query.search.trim()
      : null;

    // ── 5. Build WHERE clauses ────────────────────────────
    const ownerClause  = isAdmin ? "" : `AND p."ownerId" = :userId`;
    const searchClause = search
      ? `AND (p."nomProjet"  ILIKE :search
          OR p."entreprise"  ILIKE :search
          OR p."adresse"     ILIKE :search
          OR p."promoteur"   ILIKE :search)`
      : "";

    // Projects missing ANY of the requested fields (OR)
    const fieldCondition = fields
      .map((f) => FIELD_MISSING_SQL[f])
      .join("\n      OR ");

    const baseWhere = `
      WHERE p."isArchived" = false
        AND (${fieldCondition})
        ${ownerClause}
        ${searchClause}
    `;

    const replacements = {
      userId,
      limit,
      offset,
      ...(search ? { search: `%${search}%` } : {}),
    };

    // ── 6. Total count ────────────────────────────────────
    const [countRow] = await sequelize.query(
      `SELECT COUNT(*)::int AS count FROM projects p ${baseWhere}`,
      { replacements, type: "SELECT" }
    );
    const total = Number(countRow?.count || 0);

    // ── 7. Per-field missing counts (single query) ────────
    const filterClauses = VALID_FIELDS
      .map((f) => `COUNT(*) FILTER (WHERE ${FIELD_MISSING_SQL[f]})::int AS "${f}"`)
      .join(",\n      ");

    const [countsRow] = await sequelize.query(
      `SELECT ${filterClauses} FROM projects p ${baseWhere}`,
      { replacements, type: "SELECT" }
    );
    const missingCounts = {};
    for (const f of VALID_FIELDS) {
      missingCounts[f] = Number(countsRow?.[f] || 0);
    }

    // ── 8. Paginated rows ─────────────────────────────────
    const rows = await sequelize.query(
      `SELECT p.id,
              p."nomProjet",
              p."projectModele"::text       AS "projectModele",
              p."statut",
              p."validationStatut"::text    AS "validationStatut",
              p."isArchived",
              p."ownerId",
              p."createdAt",
              p."updatedAt",
              p."bureauControle",
              p."architecte",
              p."ingenieurResponsable",
              p."telephoneIngenieur",
              p."telephoneArchitecte",
              p."telephoneComptoir",
              p."telephoneDallagiste",
              p."adresse",
              u.email                       AS "ownerEmail",
              up.name                       AS "ownerName",
              up."avatarUrl"                AS "ownerAvatarUrl"
       FROM projects p
       LEFT JOIN users u          ON u.id          = p."ownerId"
       LEFT JOIN user_profiles up ON up."userId"   = u.id
       ${baseWhere}
       ORDER BY p."${sortBy}" ${sortDir}
       LIMIT :limit OFFSET :offset`,
      { replacements, type: "SELECT" }
    );

    // ── 9. Annotate each row with its missing fields ──────
    const items = rows.map((r) => ({
      id:                   r.id,
      nomProjet:            r.nomProjet,
      projectModele:        r.projectModele,
      statut:               r.statut,
      validationStatut:     r.validationStatut,
      ownerId:              r.ownerId,
      owner: r.ownerEmail
        ? { email: r.ownerEmail, name: r.ownerName || r.ownerEmail, avatarUrl: r.ownerAvatarUrl || null }
        : null,
      createdAt:            r.createdAt,
      updatedAt:            r.updatedAt,
      missingFields:        fields.filter((f) => FIELD_MISSING_JS[f](r)),
      // Raw field values so the frontend can display what IS filled
      fields: {
        bureauControle:       r.bureauControle       || null,
        architecte:           r.architecte           || null,
        ingenieurResponsable: r.ingenieurResponsable || null,
        telephoneIngenieur:   r.telephoneIngenieur   || null,
        telephoneArchitecte:  r.telephoneArchitecte  || null,
        adresse:              r.adresse              || null,
      },
    }));

    const response = {
      total,
      page,
      pages: Math.ceil(total / limit),
      limit,
      missingCounts,
      items,
    };

    console.log("ROUTE CALLED", req.originalUrl);
    console.log("KPI RESPONSE", JSON.stringify({
      fields,
      total,
      page,
      missingCounts,
    }));

    return res.json(response);
  } catch (err) {
    console.error("MISSING_FIELDS_ERROR:", err);
    return res.status(500).json({ message: err.message || "Server error" });
  }
}

module.exports = {
  listProjects,
  moveStage,
  assignOwner,
  updateStatus,
  listStatuses,
  getProject,
  getTimeline,
  getNotes,
  createNote,
  getProjectFull,
  archiveProject,
  unarchiveProject,
  getMissingFields,
};
