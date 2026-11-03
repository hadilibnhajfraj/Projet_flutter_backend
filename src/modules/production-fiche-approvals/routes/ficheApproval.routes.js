"use strict";

// Validation des fiches de production (PROMESH / PROBAR) par le responsable
// logistique — voir config/productionFicheApproval.js. Mêmes rôles que les
// fiches ; les droits nominatifs (validateur, créateurs) sont vérifiés dans
// le service.

const router = require("express").Router();
const ctrl = require("../controllers/ficheApproval.controller");
const { validateListQuery, validateDecision, validateResubmit } = require("../validators/ficheApproval.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole, requireRoleOrPermission } = require("../../../middleware/requireRole");
const { PERMISSIONS } = require("../../../config/rolePermissions");

const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat", "finance_production"];

// Back-office (consultation) : uniquement le DÉTAIL d'une fiche (historique
// de validation affiché dans la fiche) — ni la file de validation, ni les
// décisions (approve / reject / resubmit), réservées aux rôles ci-dessus.
const writers = requireRole(...READ_WRITE_ROLES);

router.use(authRequired);

router.get("/permissions", writers, ctrl.permissions);
router.get("/summary", writers, validateListQuery, ctrl.summary);
router.get("/", writers, validateListQuery, ctrl.list);
router.get("/:type/:id", requireRoleOrPermission(PERMISSIONS.PRODUCTION_READ_ALL, ...READ_WRITE_ROLES), ctrl.getOne);
router.post("/:type/:id/approve", writers, validateDecision, ctrl.approve);
router.post("/:type/:id/reject", writers, validateDecision, ctrl.reject);
router.post("/:type/:id/resubmit", writers, validateResubmit, ctrl.resubmit);

module.exports = router;
