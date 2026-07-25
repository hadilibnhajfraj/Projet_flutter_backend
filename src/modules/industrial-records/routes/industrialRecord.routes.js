"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/industrialRecord.controller");
const { validateCreate, validateUpdate } = require("../validators/industrialRecord.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

// Mêmes rôles que POR PROMESH — ce module générique sert PROBAR, MÉLANGE
// et MAINTENANCE, qui partagent l'espace dédié industriel.
const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat"];
const DELETE_ROLES = ["admin", "superadmin", "superadmin2"];

router.use(authRequired);

router.post("/", requireRole(...READ_WRITE_ROLES), validateCreate, ctrl.createRecord);
router.get("/", requireRole(...READ_WRITE_ROLES), ctrl.listRecords);
router.get("/:id", requireRole(...READ_WRITE_ROLES), ctrl.getRecord);
router.put("/:id", requireRole(...READ_WRITE_ROLES), validateUpdate, ctrl.updateRecord);
router.delete("/:id", requireRole(...DELETE_ROLES), ctrl.deleteRecord);

module.exports = router;
