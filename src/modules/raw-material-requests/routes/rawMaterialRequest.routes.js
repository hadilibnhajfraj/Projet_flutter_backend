"use strict";

// Demandes de matières premières (ISO, RESINE, … FIBRE) — voir config/rawMaterialRequest.js.
// Mêmes rôles que la création/lecture des fiches PROMESH/PROBAR ; la règle
// « qui doit faire une demande » (email + poste) et la visibilité / gestion
// des statuts (gestionnaires) sont vérifiées dans le service.

const router = require("express").Router();
const ctrl = require("../controllers/rawMaterialRequest.controller");
const {
  validateCreate,
  validateListQuery,
  validateStatusChange,
  validateResubmit,
  validateEveningAccept,
  validateEveningRefuse,
} = require("../validators/rawMaterialRequest.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat", "finance_production"];

router.use(authRequired);

// Déclarés avant "/:id".
router.get("/requirement", requireRole(...READ_WRITE_ROLES), ctrl.requirement);
router.get("/session-requirement", requireRole(...READ_WRITE_ROLES), ctrl.sessionRequirement);
router.get("/permissions", requireRole(...READ_WRITE_ROLES), ctrl.permissions);
router.get("/requesters", requireRole(...READ_WRITE_ROLES), ctrl.requesters);
router.get("/pending-summary", requireRole(...READ_WRITE_ROLES), ctrl.pendingSummary);
router.get("/export", requireRole(...READ_WRITE_ROLES), validateListQuery, ctrl.exportExcel);
router.post("/", requireRole(...READ_WRITE_ROLES), validateCreate, ctrl.create);
router.get("/", requireRole(...READ_WRITE_ROLES), validateListQuery, ctrl.list);
router.get("/:id", requireRole(...READ_WRITE_ROLES), ctrl.getOne);
router.patch("/:id/status", requireRole(...READ_WRITE_ROLES), validateStatusChange, ctrl.changeStatus);
// Correction d'une demande rejetée par son demandeur (même demande, pas de doublon).
router.put("/:id/resubmit", requireRole(...READ_WRITE_ROLES), validateResubmit, ctrl.resubmit);
// Shift soir (production_2, vérifié dans le service) : prise en charge ou refus d'une demande validée.
router.post("/:id/evening-accept", requireRole(...READ_WRITE_ROLES), validateEveningAccept, ctrl.eveningAccept);
router.post("/:id/evening-refuse", requireRole(...READ_WRITE_ROLES), validateEveningRefuse, ctrl.eveningRefuse);

module.exports = router;
