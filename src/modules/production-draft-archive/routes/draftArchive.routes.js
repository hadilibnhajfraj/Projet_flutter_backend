"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/draftArchive.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// Utilisateur propriétaire de la fiche archivée : demande et suivi de ses
// propres demandes.
router.post("/requests", ctrl.createRequest);
router.get("/requests/mine", ctrl.myRequests);

// Responsables uniquement (mêmes comptes que le contrôle de production).
router.get("/requests", ctrl.requireManager, ctrl.listRequests);
router.get("/requests/stats", ctrl.requireManager, ctrl.requestStats);
router.post("/requests/:id/approve", ctrl.requireManager, ctrl.approveRequest);
router.post("/requests/:id/reject", ctrl.requireManager, ctrl.rejectRequest);
router.post("/run-sweep", ctrl.requireManager, ctrl.runSweepNow);
// §12 — liste directe des fiches ACTUELLEMENT archivées (≠ demandes de désarchivage).
router.get("/archived-sheets", ctrl.requireManager, ctrl.listArchivedSheets);

module.exports = router;
