"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/productionCompliance.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireProductionPermission } = require("../../production-requests/middleware/productionPermission");
const { auditProductionAction } = require("../../production-requests/middleware/auditProductionAction");
const { PERMISSIONS: P } = require("../../../config/productionWorkflow");

router.use(authRequired);

// Tout utilisateur connecté : sa propre situation (bannière / blocage).
router.get("/me", ctrl.me);

// Demandes d'autorisation : création et suivi par l'utilisateur concerné.
router.post("/requests", ctrl.createRequest);
router.get("/requests/mine", ctrl.myRequests);

// Demandes d'autorisation : responsables historiques (inchangé) OU compte
// disposant de la permission production.authorization.* (responsable
// logistique, voir config/productionWorkflow.js).
router.get("/requests", requireProductionPermission(P.AUTHORIZATION_VIEW), ctrl.listRequests);
router.get("/requests/stats", requireProductionPermission(P.AUTHORIZATION_VIEW), ctrl.requestStats);
router.post("/requests/:id/approve", requireProductionPermission(P.AUTHORIZATION_APPROVE), auditProductionAction("APPROVE", "AUTHORIZATION"), ctrl.approveRequest);
router.post("/requests/:id/reject", requireProductionPermission(P.AUTHORIZATION_REJECT), auditProductionAction("REJECT", "AUTHORIZATION"), ctrl.rejectRequest);

// Responsables uniquement.
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
