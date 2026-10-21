"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/commercialContactKpi.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRoleOrProbarProjectManager } = require("../../../middleware/requireRole");

// ── GET /commercial-contacts/kpi ─────────────────────────────────────────────
// admin / superadmin → KPI globaux (tous contacts, tous commerciaux)
// commercial        → KPI personnels (filtré WHERE createdBy = userId)
// comptes @probardistribution.com éligibles (config/probarProjectAccess.js)
//                   → mêmes KPI personnels que commercial
router.get(
  "/kpi",
  authRequired,
  requireRoleOrProbarProjectManager("admin", "superadmin", "superadmin2", "commercial"),
  ctrl.getKPI
);

// ── GET /commercial-contacts/my-kpi ──────────────────────────────────────────
// commercial / admin / superadmin → accès autorisé (données du user connecté)
// user / accueil / autres          → 403 Access denied
router.get(
  "/my-kpi",
  authRequired,
  requireRoleOrProbarProjectManager("admin", "superadmin", "superadmin2", "commercial"),
  ctrl.getMyKpiEndpoint
);

// ── GET /commercial-contacts/analytics ───────────────────────────────────────
// admin / superadmin → global ; commercial → filtré
router.get(
  "/analytics",
  authRequired,
  requireRoleOrProbarProjectManager("admin", "superadmin", "superadmin2", "commercial"),
  ctrl.getAnalytics
);

// ── GET /commercial-contacts/kpi/me — legacy ─────────────────────────────────
router.get(
  "/kpi/me",
  authRequired,
  requireRoleOrProbarProjectManager("admin", "superadmin", "superadmin2", "commercial"),
  ctrl.getKPIMe
);

module.exports = router;
