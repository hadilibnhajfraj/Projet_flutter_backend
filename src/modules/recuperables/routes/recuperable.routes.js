"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/recuperable.controller");
const { validateSaveFiche } = require("../validators/recuperable.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

// Mêmes rôles que POR PROMESH / IndustrialRecord — module dédié aux
// opérateurs du même espace industriel. finance_production
// (§MODIFICATION — INTERFACE PRODUCTION DE DENNISREDFEATHER) obtient le même
// accès lecture/écriture, SANS le droit de suppression (voir DELETE_ROLES
// ci-dessous — décision explicite, contrairement à responsable_logistique_achat
// qui garde ce droit ici).
const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat", "finance_production"];
// Delete : inchangé par rapport à avant l'ajout de finance_production, qui
// en est volontairement exclu.
const DELETE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat"];

router.use(authRequired);
router.use(requireRole(...READ_WRITE_ROLES));

// "Enregistrer" — crée la fiche (ou ouvre celle qui existe déjà pour ce
// Module/Machine/Ligne/Poste/Date) ET upserte les 12 lignes en un seul appel.
router.post("/", validateSaveFiche, ctrl.saveFiche);
router.get("/", ctrl.listFiches);
router.get("/:id", ctrl.getFiche);
router.put("/:id/terminer", ctrl.terminerFiche);
router.delete("/:id", requireRole(...DELETE_ROLES), ctrl.deleteFiche);

module.exports = router;
