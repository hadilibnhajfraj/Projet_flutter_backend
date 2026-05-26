const express = require("express");
const router = express.Router();

const actionController = require("../controllers/projectAction.controller");
const { authRequired } = require("../middleware/auth.middleware");
const { validateCreateAction } = require("../middleware/projectAction.validation");
const { actionUpload } = require("../middleware/actionUpload.middleware");

/*
Ajouter action CRM
Order matters: Multer must run before validation so req.body is populated
from the multipart/form-data payload before any field is read.
*/
router.post(
  "/projects/:projectId/actions",
  authRequired,
  actionUpload.single("file"),
  validateCreateAction,
  actionController.createAction
);

/*
Historique actions
*/
router.get(
  "/projects/:projectId/actions",
  authRequired,
  actionController.getProjectActions
);

/*
Timeline CRM
*/
router.get(
  "/projects/:projectId/timeline",
  authRequired,
  actionController.getTimeline
);

module.exports = router;