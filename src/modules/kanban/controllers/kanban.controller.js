const svc = require("../services/kanban.service");

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

module.exports = { getKanban };
