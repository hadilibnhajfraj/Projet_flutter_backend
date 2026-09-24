"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/reports.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

// Rapport de pilotage : lecture seule, données globales et sensibles
// (activité nominative des utilisateurs) → rôles administrateurs uniquement.
// moduleAccessGuard bloque déjà /reports pour les rôles à périmètre restreint.
const REPORT_ROLES = ["admin", "superadmin", "superadmin2"];

router.use(authRequired);
router.use(requireRole(...REPORT_ROLES));

router.get("/filters", ctrl.filters);
router.get("/overview", ctrl.overview);
router.get("/commercials", ctrl.commercials);
router.get("/projects/archived", ctrl.archived);
router.get("/projects", ctrl.projects);
router.get("/contacts", ctrl.contacts);
router.get("/users/:id", ctrl.userDetail);
router.get("/users", ctrl.users);
router.get("/activity", ctrl.activity);
router.get("/industrial", ctrl.industrial);
router.get("/machines", ctrl.machines);
router.get("/production", ctrl.production);
router.get("/data-quality", ctrl.dataQuality);
router.get("/recommendations", ctrl.recommendations);
router.get("/export/excel", ctrl.exportExcel);
router.get("/export/pdf", ctrl.exportPdf);

module.exports = router;
