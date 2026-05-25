const router = require("express").Router();
const ctrl = require("../controllers/project.controller");
const { validateMoveStage, validateAssignOwner, validateListQuery } = require("../validators/project.validator");
const { requireOwnerOrAdmin } = require("../policies/project.policy");
const activityRoutes = require("../../project-activities/routes/projectActivity.routes");
const actionRoutes = require("../../project-actions/routes/projectAction.routes");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// Enhanced project list: ?mine=true&stageId=X&search=X&page=1&limit=20&sortBy=createdAt
router.get("/pipeline", validateListQuery, ctrl.listProjects);

// Move project to new pipeline stage (Drag & Drop)
router.put("/:id/move-stage", requireOwnerOrAdmin, validateMoveStage, ctrl.moveStage);

// Assign / remove owner
router.put("/:id/owner", requireOwnerOrAdmin, validateAssignOwner, ctrl.assignOwner);

// Nested resources
router.use("/:projectId/actions", actionRoutes);
router.use("/:projectId/activities", activityRoutes);

module.exports = router;
