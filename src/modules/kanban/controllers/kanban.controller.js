const svc = require("../services/kanban.service");
const projectSvc = require("../../projects/services/project.service");

/**
 * GET /pipeline/kanban
 *
 * Query params:
 *   mine=true          — only projects owned by current user
 *   projectModele=...  — filter by model (project | revendeur | applicateur)
 *   search=...         — full-text filter on nomProjet / entreprise / adresse
 */
async function getKanban(req, res) {
  try {
    const board = await svc.getKanbanBoard({
      mine: req.query.mine,
      userId: req.user.sub,
      projectModele: req.query.projectModele || null,
      search: req.query.search || null,
    });
    res.json({ data: board });
  } catch (err) {
    console.error("Kanban error:", err);
    res.status(500).json({ message: err.message || "Failed to load kanban board" });
  }
}

/**
 * GET /pipeline/stages
 * All pipeline stages with per-stage projectsCount (60 s TTL cache).
 */
async function getStages(req, res) {
  try {
    const stages = await svc.getStagesWithCount();
    res.json({ data: stages });
  } catch (err) {
    console.error("getStages error:", err);
    res.status(500).json({ message: err.message || "Failed to load stages" });
  }
}

/**
 * GET /pipeline/projects
 * Paginated, filtered project list — same power as the main project list
 * but mounted under /pipeline for the kanban sidebar / list view.
 *
 * Accepts all the same query params as GET /projects:
 *   page, limit, sortBy, sortDir, mine, stageId, search, projectModele,
 *   isArchived, ownerId, dateFrom, dateTo
 */
async function getPipelineProjects(req, res) {
  try {
    const result = await projectSvc.listProjects(req.query, req.user.sub);
    res.json(result);
  } catch (err) {
    console.error("getPipelineProjects error:", err);
    res.status(err.status || 500).json({ message: err.message || "Failed to load projects" });
  }
}

/**
 * PUT /pipeline/projects/:id/stage
 * Fast drag-and-drop stage move (no activity log, tiny response).
 * Body: { stageId: "<uuid>" }
 */
async function moveStageFast(req, res) {
  try {
    const { stageId } = req.body;
    if (!stageId) return res.status(400).json({ message: "stageId is required" });

    const result = await svc.moveStageFast(req.params.id, stageId);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("moveStageFast error:", err);
    res.status(err.status || 500).json({ message: err.message || "Failed to move project" });
  }
}

module.exports = { getKanban, getStages, getPipelineProjects, moveStageFast };
