"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/industrialRecord.controller");
const { validateCreate, validateUpdate } = require("../validators/industrialRecord.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole, requireRoleOrPermission } = require("../../../middleware/requireRole");
const { PERMISSIONS } = require("../../../config/rolePermissions");
const { complianceGuard } = require("../../production-compliance/middleware/productionComplianceGuard");
const { rawMaterialRequestGuard } = require("../../raw-material-requests/middleware/rawMaterialRequestGuard");

// Mêmes rôles que POR PROMESH — ce module générique sert PROBAR, MÉLANGE
// et MAINTENANCE, qui partagent l'espace dédié industriel. finance_production
// (§MODIFICATION — INTERFACE PRODUCTION DE DENNISREDFEATHER) reçoit le même
// accès que responsable_logistique_achat ici, en plus de Finance.
const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat", "finance_production"];
const DELETE_ROLES = ["admin", "superadmin", "superadmin2"];
// Consultation (GET uniquement) : + permission production.read_all (compte back-office).
const consult = requireRoleOrPermission(PERMISSIONS.PRODUCTION_READ_ALL, ...READ_WRITE_ROLES);

router.use(authRequired);

router.post("/", requireRole(...READ_WRITE_ROLES), validateCreate, complianceGuard({ source: "probar", mode: "create" }), rawMaterialRequestGuard({ source: "probar" }), ctrl.createRecord);
router.get("/", consult, ctrl.listRecords);
router.get("/:id", consult, ctrl.getRecord);
router.put("/:id", requireRole(...READ_WRITE_ROLES), validateUpdate, complianceGuard({ source: "probar", mode: "update" }), ctrl.updateRecord);
router.delete("/:id", requireRole(...DELETE_ROLES), ctrl.deleteRecord);

module.exports = router;
