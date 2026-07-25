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

// GET /dashboard/user — KPI BI du dashboard utilisateur (cartes cliquables,
// répartition famille/diamètre) — accessible à tout utilisateur authentifié,
// PAS de kpiRoleGuard (volontaire : c'est son propre dashboard personnel).
router.get("/user", ctrl.getUserDashboard);

module.exports = router;
