const router = require("express").Router({ mergeParams: true });
const ctrl = require("../controllers/projectActivity.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// GET /projects/:projectId/activities
router.get("/", ctrl.listActivities);

module.exports = router;
