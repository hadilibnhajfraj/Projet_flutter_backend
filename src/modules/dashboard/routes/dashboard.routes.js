"use strict";

const router = require("express").Router();
const ctrl   = require("../controllers/dashboard.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// GET /dashboard/kpis — legacy: pipeline funnel + revenue
router.get("/kpis", ctrl.getKPIs);

// GET /dashboard/kpi — role-aware basic KPI
// admin → platform-wide stats, top users/revendeurs/applicateurs, charts
// user  → personal stats filtered by ownerId
router.get("/kpi", ctrl.getKPIByRole);

// GET /dashboard/professional — comprehensive role-aware dashboard
// Returns: summary, performance, pipeline, maps, alerts
router.get("/professional", ctrl.getProfessionalDashboard);

module.exports = router;
