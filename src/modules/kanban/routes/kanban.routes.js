const router = require("express").Router();
const ctrl = require("../controllers/kanban.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// GET /pipeline/kanban?projectModele=project&mine=true
router.get("/kanban", ctrl.getKanban);

module.exports = router;
