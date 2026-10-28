"use strict";

// Validation des fiches de production (PROMESH / PROBAR) par le responsable
// logistique — voir config/productionFicheApproval.js. Mêmes rôles que les
// fiches ; les droits nominatifs (validateur, créateurs) sont vérifiés dans
// le service.

const router = require("express").Router();
const ctrl = require("../controllers/ficheApproval.controller");
const { validateListQuery, validateDecision, validateResubmit } = require("../validators/ficheApproval.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat", "finance_production"];

router.use(authRequired, requireRole(...READ_WRITE_ROLES));

router.get("/permissions", ctrl.permissions);
router.get("/summary", validateListQuery, ctrl.summary);
router.get("/", validateListQuery, ctrl.list);
router.get("/:type/:id", ctrl.getOne);
router.post("/:type/:id/approve", validateDecision, ctrl.approve);
router.post("/:type/:id/reject", validateDecision, ctrl.reject);
router.post("/:type/:id/resubmit", validateResubmit, ctrl.resubmit);

module.exports = router;
