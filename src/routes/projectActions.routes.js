const express = require("express");
const router = express.Router();

const actionController = require("../controllers/projectAction.controller");

const { authRequired } = require("../middleware/auth.middleware");

/*
Ajouter action CRM
*/
router.post(
  "/projects/:projectId/actions",
  authRequired,
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