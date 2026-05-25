const PipelineStage = require("../../../models/PipelineStage");
const projectRepo = require("../../projects/repositories/project.repository");

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
    // No ownerId on the project — use legacy user_nom field or "—"
    const displayName = projectFallbackName || "Non assigné";
    return {
      id: null,
      email: null,
      name: displayName,
      initials: _initials(displayName),
      avatar: null,
    };
  }

  const u = user.toJSON ? user.toJSON() : user;
  const profile = u.profile || {};

  // UserProfile.name is the single full-name field
  const name = (profile.name || "").trim() || u.email || "—";
  const avatarUrl = profile.avatarUrl || null;

  return {
    id: u.id,
    email: u.email,
    name,
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

  // Fallback display name from legacy fields when ownerId is null
  const fallbackName = p.user_nom_custom || p.user_nom || null;

  return {
    id: p.id,
    nomProjet: p.nomProjet,
    typeProjet: p.typeProjet || null,
    statut: p.statut || null,
    projectModele: p.projectModele,

    // Owner — always present, never null
    owner: toOwnerShape(p.owner, fallbackName),

    // Stage
    stage: p.stage
      ? {
          id: p.stage.id,
          name: p.stage.name,
          color: p.stage.color,
          icon: p.stage.icon,
          position: p.stage.position,
          isWonStage: p.stage.isWonStage,
          isLostStage: p.stage.isLostStage,
        }
      : null,

    // Latest ProjectAction (inline correlated subquery — plain object)
    lastAction: p.lastAction || null,

    // Metrics
    actionsCount: p.actionsCount || 0,
    pourcentageReussite: p.pourcentageReussite !== null ? parseFloat(p.pourcentageReussite) : null,
    montantMarche: p.montantMarche !== null ? parseFloat(p.montantMarche) : null,

    adresse: p.adresse || null,
    lastRelanceAt: p.lastRelanceAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

module.exports = { getKanbanBoard, toProjectCard };
