"use strict";

// "Production — Statistiques des demandes" + historique/audit des demandes
// Production. Lecture seule : les décisions (approve/reject) restent sur les
// routes existantes /production-compliance/requests/* et
// /production-draft-archive/requests/*.

const router = require("express").Router();
const ctrl = require("../controllers/productionRequests.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireProductionPermission } = require("../middleware/productionPermission");
const { PERMISSIONS: P } = require("../../../config/productionWorkflow");

router.use(authRequired);

router.get("/permissions", ctrl.myPermissions);
router.get("/statistics", requireProductionPermission(P.STATISTICS_VIEW), ctrl.statistics);
router.get("/history", requireProductionPermission(P.STATISTICS_VIEW), ctrl.history);
router.get("/audit", requireProductionPermission(P.STATISTICS_VIEW), ctrl.auditLog);

// Historique d'UNE demande — permission de consultation du type concerné.
router.get("/authorization/:id/history", requireProductionPermission(P.AUTHORIZATION_VIEW), (req, res) => {
  req.params.type = "AUTHORIZATION";
  return ctrl.requestHistory(req, res);
});
router.get("/unarchive/:id/history", requireProductionPermission(P.ARCHIVE_VIEW), (req, res) => {
  req.params.type = "UNARCHIVE";
  return ctrl.requestHistory(req, res);
});

module.exports = router;
