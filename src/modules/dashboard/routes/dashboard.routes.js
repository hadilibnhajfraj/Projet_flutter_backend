"use strict";

const router = require("express").Router();
const ctrl   = require("../controllers/dashboard.controller");
const { authRequired }  = require("../../../middleware/auth.middleware");
const { kpiRoleGuard }  = require("../../../middleware/kpiRoleGuard");

router.use(authRequired);

// GET /dashboard/kpis — legacy pipeline funnel + revenue — admin/superadmin only
router.get("/kpis", kpiRoleGuard, ctrl.getKPIs);

// GET /dashboard/kpi — KPI global plateforme — admin/superadmin only
router.get("/kpi", kpiRoleGuard, ctrl.getKPIByRole);

// GET /dashboard/professional — dashboard complet — admin/superadmin only
router.get("/professional", kpiRoleGuard, ctrl.getProfessionalDashboard);

module.exports = router;
