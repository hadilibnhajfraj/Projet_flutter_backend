const router = require("express").Router();
const ctrl = require("../controllers/projectAction.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

router.use(authRequired);

// ── Action Types (mounted at /action-types) ───────────────
router.get("/", ctrl.listActionTypes);
router.post("/", requireRole("admin", "superadmin", "superadmin2"), ctrl.createActionType);
router.put("/:id", requireRole("admin", "superadmin", "superadmin2"), ctrl.updateActionType);
router.delete("/:id", requireRole("admin", "superadmin", "superadmin2"), ctrl.deleteActionType);

module.exports = router;
