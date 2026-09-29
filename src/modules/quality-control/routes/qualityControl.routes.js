"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/qualityControl.controller");
const { validateCreate, validateUpdate, validateValidate } = require("../validators/qualityControl.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");
const cfg = require("../../../config/qualityControl");

// RBAC existant (requireRole + moduleAccessGuard) — aucun système parallèle.
// controle_qualite : créer/remplir/valider/consulter SES contrôles (portée
// appliquée dans le service). Suppression (logique) réservée aux admins.
const WRITE_ROLES = cfg.writeRoles;
const DELETE_ROLES = cfg.deleteRoles;

router.use(authRequired);

// IMPORTANT : déclarés avant "/:id" (même piège que por-promesh).
router.get("/parameters", requireRole(...WRITE_ROLES), ctrl.listParameters);
router.get("/production/:productionRecordId", requireRole(...WRITE_ROLES), ctrl.listByProductionRecord);

router.get("/", requireRole(...WRITE_ROLES), ctrl.listControls);
router.post("/", requireRole(...WRITE_ROLES), validateCreate, ctrl.createControl);

router.get("/:id", requireRole(...WRITE_ROLES), ctrl.getControl);
router.put("/:id", requireRole(...WRITE_ROLES), validateUpdate, ctrl.updateControl);
router.post("/:id/validate", requireRole(...WRITE_ROLES), validateValidate, ctrl.validateControl);
router.delete("/:id", requireRole(...DELETE_ROLES), ctrl.deleteControl);

module.exports = router;
