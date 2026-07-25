"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/adminDashboard.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { kpiRoleGuard } = require("../../../middleware/kpiRoleGuard");

router.use(authRequired);

// GET /admin-dashboard/stats — vue consolidée PROMESH/PROBAR/Maintenance/
// RH/Mélange/Récupérables — réservée admin/superadmin (superadmin n'a par
// ailleurs aucune restriction de scope, voir modules por-promesh et
// industrial-records : isOwnerScoped ne s'applique qu'à
// responsable_logistique_achat).
router.get("/stats", kpiRoleGuard, ctrl.getStats);

module.exports = router;
