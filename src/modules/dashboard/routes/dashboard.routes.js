const router = require("express").Router();
const ctrl = require("../controllers/dashboard.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// GET /dashboard/kpis
// Returns: counts, revenue, conversion rate, funnel by stage, monthly trend
router.get("/kpis", ctrl.getKPIs);

module.exports = router;
