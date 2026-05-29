const PipelineStage = require("../../../models/PipelineStage");
const projectRepo = require("../../projects/repositories/project.repository");
const stageRepo = require("../../pipeline/repositories/pipelineStage.repository");
const { sequelize } = require("../../../db");
const { computeCompletion } = require("../../projects/utils/project.completion");

// ── TTL cache for pipeline stages (60 s) ─────────────────────────────────────
const _stageCache = { data: null, expiresAt: 0 };
const STAGE_TTL_MS = 60_000;

function _invalidateStageCache() {
  _stageCache.data = null;
  _stageCache.expiresAt = 0;
}

/**
 * Returns the full Kanban board grouped by pipeline stage.
 *
 * mine=false  → no owner filter  → ALL projects from all users
 * mine=true   → ownerId filter   → only current user's projects
 *
 * Each column: { stage, projects: [ ProjectCard ] }
 * Total SQL queries: 2 (stages + projects — counts/lastAction are inline subqueries)
 */
async function getKanbanBoard({ mine, userId, projectModele, search }) {
  // ── 1. All stages ordered by position ───────────────────
  const stages = await PipelineStage.findAll({
    attributes: ["id", "name", "color", "icon", "position", "isWonStage", "isLostStage", "autoCreateAction"],
    order: [["position", "ASC"]],
  });

  // ── 2. All projects (single query, inline counts + last action) ──
  const ownerId = mine === "true" && userId ? userId : null;

  const projects = await projectRepo.findAllForKanban({
    projectModele: projectModele || null,
    ownerId,
    search: search || null,
  });

  // ── 3. Build stage map ───────────────────────────────────
  const stageMap = new Map();
  for (const stage of stages) {
    stageMap.set(stage.id, { stage: toStageShape(stage), projects: [] });
  }

  const unassigned = { stage: null, projects: [] };

  for (const project of projects) {
    const card = toProjectCard(project);
    if (project.pipelineStageId && stageMap.has(project.pipelineStageId)) {
      stageMap.get(project.pipelineStageId).projects.push(card);
    } else {
      unassigned.projects.push(card);
    }
  }

  const columns = Array.from(stageMap.values());
  if (unassigned.projects.length > 0) columns.push(unassigned);

  return columns;
}

// ── Priority metadata ─────────────────────────────────────

const PRIORITY_META = {
  low:    { color: "#6b7280", label: "Faible",  icon: "trending-down" },
  medium: { color: "#3b82f6", label: "Normal",  icon: "minus" },
  high:   { color: "#f59e0b", label: "Élevé",   icon: "trending-up" },
  urgent: { color: "#ef4444", label: "Urgent",  icon: "alert-triangle" },
};

// ── Shape builders ────────────────────────────────────────

function toStageShape(stage) {
  const s = stage.toJSON ? stage.toJSON() : stage;
  return {
    id: s.id,
    name: s.name,
    color: s.color,
    icon: s.icon,
    position: s.position,
    isWonStage: s.isWonStage,
    isLostStage: s.isLostStage,
    autoCreateAction: s.autoCreateAction,
  };
}

/**
 * Builds an owner object from the eagerly-loaded User + UserProfile.
 * UserProfile fields: name (single field), avatarUrl.
 * Falls back to email when name is missing.
 * Never returns null — always returns a shape with at least initials.
 */
function toOwnerShape(user, projectFallbackName) {
  if (!user) {
    const displayName = projectFallbackName || "Utilisateur";
    return {
      id: null,
      email: "Aucun email",
      name: displayName,
      fullName: displayName,
      initials: _initials(displayName),
      avatar: null,
    };
  }

  const u = user.toJSON ? user.toJSON() : user;
  const profile = u.profile || {};

  const name = (profile.name || "").trim() || u.email || "Utilisateur";
  const avatarUrl = profile.avatarUrl || null;

  return {
    id: u.id,
    email: u.email || "Aucun email",
    name,
    fullName: name,
    initials: _initials(name),
    avatar: avatarUrl,
  };
}

function _initials(name) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function toProjectCard(project) {
  const p = project.toJSON ? project.toJSON() : project;

  const fallbackName = p.user_nom_custom || p.user_nom || null;
  const ownerShape = toOwnerShape(p.owner, fallbackName);

  // lastAction comes from the correlated SQL subquery (LAST_ACTION_ATTR)
  const lastAction = p.lastAction || null;
  const currentAction =
    lastAction?.typeAction_legacy ||
    lastAction?.actionType?.name ||
    "Aucune action";

  const stageShape = p.stage
    ? {
        id: p.stage.id,
        name: p.stage.name,
        color: p.stage.color,
        icon: p.stage.icon,
        position: p.stage.position,
        isWonStage: p.stage.isWonStage,
        isLostStage: p.stage.isLostStage,
      }
    : null;

  const priorityKey = (p.priority || "medium");
  const priorityMeta = PRIORITY_META[priorityKey] || PRIORITY_META.medium;

  return {
    id: p.id,

    // Project name — both keys so Flutter can use either
    nomProjet: p.nomProjet,
    title: p.nomProjet || p.comptoir || "Projet sans nom",

    typeProjet: p.typeProjet || null,
    statut: p.statut || null,
    projectModele: p.projectModele,

    // Priority
    priority: priorityKey,
    priorityColor: priorityMeta.color,
    priorityLabel: priorityMeta.label,
    priorityIcon: priorityMeta.icon,

    // FK fields
    ownerId: p.ownerId || null,
    pipelineStageId: p.pipelineStageId || null,

    // Owner — always an object, never null
    owner: ownerShape,

    // Stage — under both keys Flutter might query
    stage: stageShape,
    pipelineStage: stageShape,

    // CRM action fields
    currentAction,
    lastAction,

    // Kanban badge counts
    actionsCount: p.actionsCount || 0,
    notesCount: p.notesCount || 0,
    upcomingRemindersCount: p.upcomingRemindersCount || 0,
    attachmentsCount: p.attachmentsCount || 0,

    pourcentageReussite: p.pourcentageReussite !== null ? parseFloat(p.pourcentageReussite) : null,
    montantMarche: p.montantMarche !== null ? parseFloat(p.montantMarche) : null,

    adresse: p.adresse || null,
    dateDemarrage: p.dateDemarrage ?? null,
    startDate:     p.dateDemarrage ?? null,
    lastRelanceAt: p.lastRelanceAt,
    nextRelanceDate: p.nextRelanceDate ?? null,
    relanceStatus: (() => {
      if (!p.nextRelanceDate) return "none";
      return new Date(p.nextRelanceDate) < new Date() ? "late" : "ok";
    })(),
    isArchived: p.isArchived || false,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,

    ...computeCompletion(p),
  };
}

/**
 * Returns all pipeline stages with per-stage projectsCount.
 * Result is cached for 60 seconds to avoid hitting the DB on every kanban render.
 */
async function getStagesWithCount() {
  if (_stageCache.data && Date.now() < _stageCache.expiresAt) {
    return _stageCache.data;
  }
  const stages = await stageRepo.findAllWithProjectCount();
  _stageCache.data = stages.map((s) => {
    const j = s.toJSON ? s.toJSON() : s;
    return {
      id: j.id,
      name: j.name,
      color: j.color,
      icon: j.icon,
      position: j.position,
      isWonStage: j.isWonStage,
      isLostStage: j.isLostStage,
      autoCreateAction: j.autoCreateAction,
      projectsCount: j.projectsCount ?? 0,
    };
  });
  _stageCache.expiresAt = Date.now() + STAGE_TTL_MS;
  return _stageCache.data;
}

/**
 * Fast drag-and-drop stage move — skips activity logging and full project reload.
 * Use for kanban D&D where the Flutter UI already optimistically updates the card.
 * Returns only { id, pipelineStageId } so the response is tiny.
 */
async function moveStageFast(projectId, newStageId) {
  const [count] = await sequelize.query(
    `UPDATE projects SET "pipelineStageId" = :stageId, "updatedAt" = NOW()
     WHERE id = :projectId AND "isArchived" = false`,
    { replacements: { stageId: newStageId, projectId }, type: sequelize.QueryTypes.UPDATE }
  );
  if (count === 0) throw { status: 404, message: "Project not found or archived" };

  // Bust the stage counts cache so the next /stages call reflects the move.
  _invalidateStageCache();

  return { id: projectId, pipelineStageId: newStageId };
}

module.exports = { getKanbanBoard, getStagesWithCount, moveStageFast, toProjectCard };
