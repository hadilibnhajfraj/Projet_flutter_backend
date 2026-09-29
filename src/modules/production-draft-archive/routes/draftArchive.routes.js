"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/draftArchive.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireProductionPermission } = require("../../production-requests/middleware/productionPermission");
const { auditProductionAction } = require("../../production-requests/middleware/auditProductionAction");
const { PERMISSIONS: P } = require("../../../config/productionWorkflow");

router.use(authRequired);

// Utilisateur propriétaire de la fiche archivée : demande et suivi de ses
// propres demandes.
router.post("/requests", ctrl.createRequest);
router.get("/requests/mine", ctrl.myRequests);

// Demandes de désarchivage : responsables historiques (inchangé) OU compte
// disposant de la permission production.archive.* (responsable logistique).
router.get("/requests", requireProductionPermission(P.ARCHIVE_VIEW), ctrl.listRequests);
router.get("/requests/stats", requireProductionPermission(P.ARCHIVE_VIEW), ctrl.requestStats);
router.post("/requests/:id/approve", requireProductionPermission(P.ARCHIVE_APPROVE), auditProductionAction("APPROVE", "UNARCHIVE"), ctrl.approveRequest);
router.post("/requests/:id/reject", requireProductionPermission(P.ARCHIVE_REJECT), auditProductionAction("REJECT", "UNARCHIVE"), ctrl.rejectRequest);
// §12 — liste directe des fiches ACTUELLEMENT archivées (≠ demandes de désarchivage).
router.get("/archived-sheets", requireProductionPermission(P.ARCHIVE_VIEW), ctrl.listArchivedSheets);

// Responsables uniquement (mêmes comptes que le contrôle de production).
router.post("/run-sweep", ctrl.requireManager, ctrl.runSweepNow);

module.exports = router;
