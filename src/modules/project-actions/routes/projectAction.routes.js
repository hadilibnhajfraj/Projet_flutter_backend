const router = require("express").Router({ mergeParams: true });
const ctrl = require("../controllers/projectAction.controller");
const { validateCreate, validateUpdate } = require("../validators/projectAction.validator");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// ── Project-scoped actions  (mounted at /projects/:projectId/actions) ──
router.get("/",    ctrl.listActions);
router.get("/:id", ctrl.getAction);
router.post("/",   validateCreate, ctrl.createAction);
router.put("/:id", validateUpdate, ctrl.updateAction);
router.delete("/:id", ctrl.deleteAction);

module.exports = router;
