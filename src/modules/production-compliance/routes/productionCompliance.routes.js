"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/productionCompliance.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// Tout utilisateur connecté : sa propre situation (bannière / blocage).
router.get("/me", ctrl.me);

// Demandes d'autorisation : création et suivi par l'utilisateur concerné.
router.post("/requests", ctrl.createRequest);
router.get("/requests/mine", ctrl.myRequests);

// Responsables uniquement.
router.get("/requests", ctrl.requireManager, ctrl.listRequests);
router.get("/requests/stats", ctrl.requireManager, ctrl.requestStats);
router.post("/requests/:id/approve", ctrl.requireManager, ctrl.approveRequest);
router.post("/requests/:id/reject", ctrl.requireManager, ctrl.rejectRequest);
router.post("/requests/:id/retry-email", ctrl.requireManager, ctrl.retryRequestEmail);
router.post("/alerts/:id/retry-email", ctrl.requireManager, ctrl.retryAlertEmail);
router.post("/smtp-check", ctrl.requireManager, ctrl.smtpCheck);
router.get("/", ctrl.requireManager, ctrl.list);
router.get("/summary", ctrl.requireManager, ctrl.summary);
router.get("/authorizations", ctrl.requireManager, ctrl.listAuths);
router.post("/authorizations", ctrl.requireManager, ctrl.createAuth);
router.post("/authorizations/:id/revoke", ctrl.requireManager, ctrl.revokeAuth);
router.post("/run-check", ctrl.requireManager, ctrl.runCheckNow);

module.exports = router;
