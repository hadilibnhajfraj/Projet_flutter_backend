const router = require("express").Router({ mergeParams: true });
const ctrl = require("../controllers/projectAction.controller");
const { validateCreate, validateUpdate } = require("../validators/projectAction.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { actionUpload } = require("../../../middleware/actionUpload.middleware");

router.use(authRequired);

// ── Project-scoped actions  (mounted at /projects/:projectId/actions) ──
// Multer must run before validateCreate so req.body is populated from
// multipart/form-data before Joi reads any field.
router.get("/",    ctrl.listActions);
router.get("/:id", ctrl.getAction);
router.post("/",   actionUpload.single("file"), validateCreate, ctrl.createAction);
router.put("/:id", validateUpdate, ctrl.updateAction);
router.delete("/:id", ctrl.deleteAction);

module.exports = router;
