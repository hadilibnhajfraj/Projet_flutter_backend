"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/recuperable.controller");
const { validateSaveFiche } = require("../validators/recuperable.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

// Mêmes rôles que POR PROMESH / IndustrialRecord — module dédié aux
// opérateurs du même espace industriel.
const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat"];

router.use(authRequired);
router.use(requireRole(...READ_WRITE_ROLES));

// "Enregistrer" — crée la fiche (ou ouvre celle qui existe déjà pour ce
// Module/Machine/Ligne/Poste/Date) ET upserte les 12 lignes en un seul appel.
router.post("/", validateSaveFiche, ctrl.saveFiche);
router.get("/", ctrl.listFiches);
router.get("/:id", ctrl.getFiche);
router.put("/:id/terminer", ctrl.terminerFiche);
router.delete("/:id", ctrl.deleteFiche);

module.exports = router;
