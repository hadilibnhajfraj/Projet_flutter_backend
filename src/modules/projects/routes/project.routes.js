const router = require("express").Router();
const ctrl = require("../controllers/project.controller");
const { exportProjects } = require("../controllers/projectExport.controller");
const { validateMoveStage, validateAssignOwner, validateListQuery } = require("../validators/project.validator");
const { requireOwnerOrAdmin } = require("../policies/project.policy");
const activityRoutes = require("../../project-activities/routes/projectActivity.routes");
const actionRoutes = require("../../project-actions/routes/projectAction.routes");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// Guard: /:id and /:projectId params MUST be valid UUIDs.
// Non-UUID segments (e.g. "my-projects", "applicateur") are skipped so the
// legacy router mounted after this one can handle them.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param("id",        (req, res, next, val) => UUID_RE.test(val) ? next() : next("router"));
router.param("projectId", (req, res, next, val) => UUID_RE.test(val) ? next() : next("router"));

// Available statuses for a given projectModele — static, no UUID needed
router.get("/statuses", ctrl.listStatuses);

// Excel export — must be before /:id catch-all
// ?type=project|revendeur|applicateur &status=... &validation=... &startDate=... &endDate=...
router.get("/export", exportProjects);

// Enhanced project list: ?mine=true&stageId=X&search=X&page=1&limit=20&sortBy=createdAt
router.get("/pipeline", validateListQuery, ctrl.listProjects);

// Projects with missing required fields
// ?field=bureauControle|architecte|ingenieur|telephone|adresse (repeatable, OR logic)
// ?page=1 &limit=20 &sortBy=createdAt &sortDir=DESC &search=...
router.get("/missing-fields", ctrl.getMissingFields);

// Move project to new pipeline stage (Drag & Drop)
router.put("/:id/move-stage", requireOwnerOrAdmin, validateMoveStage, ctrl.moveStage);

// Assign / remove owner
router.put("/:id/owner", requireOwnerOrAdmin, validateAssignOwner, ctrl.assignOwner);

// Specific sub-resource routes must come BEFORE the bare /:id catch-all
router.put("/:id/status", ctrl.updateStatus);
router.put("/:id/archive", ctrl.archiveProject);
router.put("/:id/unarchive", ctrl.unarchiveProject);
router.get("/:id/full", ctrl.getProjectFull);
router.get("/:id/timeline", ctrl.getTimeline);
router.get("/:id/notes", ctrl.getNotes);
router.post("/:id/notes", ctrl.createNote);

// Full project detail for edit form — USER: own project / ADMIN: any
router.get("/:id", ctrl.getProject);

// Nested resources
router.use("/:projectId/actions", actionRoutes);
router.use("/:projectId/activities", activityRoutes);

module.exports = router;
