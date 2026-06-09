"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/commercialContactKpi.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

console.log("[CommercialContactKPI] middleware loaded:", { authRequired: typeof authRequired, requireRole: typeof requireRole });

// ── admin / superadmin — données complètes ou filtrées selon rôle ─────────────
router.get("/kpi",       authRequired, requireRole("admin", "superadmin", "commercial"), ctrl.getKPI);
router.get("/analytics", authRequired, requireRole("admin", "superadmin", "commercial"), ctrl.getAnalytics);

// ── /kpi/me — vue personnelle, filtrée sur l'utilisateur connecté ─────────────
router.get("/kpi/me",    authRequired, requireRole("admin", "superadmin", "commercial"), ctrl.getMyKPI);

module.exports = router;
