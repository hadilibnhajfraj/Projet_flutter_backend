const router = require("express").Router();
const ctrl = require("../controllers/pipelineStage.controller");
const { validateCreate, validateUpdate, validateReorder } = require("../validators/pipelineStage.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

router.use(authRequired);

router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);
router.post("/", requireRole("admin", "superadmin", "superadmin2"), validateCreate, ctrl.create);
router.put("/reorder", requireRole("admin", "superadmin", "superadmin2"), validateReorder, ctrl.reorder);
router.put("/:id", requireRole("admin", "superadmin", "superadmin2"), validateUpdate, ctrl.update);
router.delete("/:id", requireRole("admin", "superadmin", "superadmin2"), ctrl.remove);

module.exports = router;
