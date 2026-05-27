const router = require("express").Router();
const ctrl = require("../controllers/kanban.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// GET /pipeline/kanban?projectModele=project&mine=true
router.get("/kanban", ctrl.getKanban);

// GET /pipeline/stages — all stages with projectsCount (60 s cache)
router.get("/stages", ctrl.getStages);

// GET /pipeline/projects — paginated project list (same filters as GET /projects)
router.get("/projects", ctrl.getPipelineProjects);

// PUT /pipeline/projects/:id/stage — fast D&D move (no activity log)
router.put("/projects/:id/stage", ctrl.moveStageFast);

module.exports = router;
