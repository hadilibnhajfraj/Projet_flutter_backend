const router = require("express").Router();
const ctrl = require("../controllers/pipelineStage.controller");
const { validateCreate, validateUpdate, validateReorder } = require("../validators/pipelineStage.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

router.use(authRequired);

router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);
router.post("/", requireRole("admin", "superadmin"), validateCreate, ctrl.create);
router.put("/reorder", requireRole("admin", "superadmin"), validateReorder, ctrl.reorder);
router.put("/:id", requireRole("admin", "superadmin"), validateUpdate, ctrl.update);
router.delete("/:id", requireRole("admin", "superadmin"), ctrl.remove);

module.exports = router;
