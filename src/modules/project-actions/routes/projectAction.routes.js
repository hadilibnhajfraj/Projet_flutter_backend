const router = require("express").Router({ mergeParams: true });
const ctrl = require("../controllers/projectAction.controller");
const { validateCreate } = require("../validators/projectAction.validator");
const { handleUploadError } = require("../../../middleware/projectAction.validation");
const { authRequired } = require("../../../middleware/auth.middleware");
const { actionUpload } = require("../../../middleware/actionUpload.middleware");

router.use(authRequired);

// ── Project-scoped actions  (mounted at /projects/:projectId/actions) ──
// Multer must run before any body-reading middleware so req.body is populated
// from multipart/form-data. handleUploadError catches Multer errors (bad file
// type, size exceeded) and returns 400 instead of letting them bubble to 500.
router.get("/",    ctrl.listActions);
router.get("/:id", ctrl.getAction);
router.post("/",   actionUpload.single("file"), handleUploadError, validateCreate,  ctrl.createAction);
router.put("/:id", actionUpload.single("file"), handleUploadError,                  ctrl.updateAction);
router.delete("/:id", ctrl.deleteAction);

module.exports = router;
