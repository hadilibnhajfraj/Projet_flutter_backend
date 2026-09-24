"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/productionFollowUp.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// Responsables uniquement (mêmes comptes que Production Compliance / Draft Archive).
router.get("/alerts", ctrl.requireManager, ctrl.listAlerts);
router.post("/alerts/:id/retry-email", ctrl.requireManager, ctrl.retryEmail);
router.post("/alerts/:id/ignore", ctrl.requireManager, ctrl.ignoreAlert);
router.post("/run-sweep", ctrl.requireManager, ctrl.runSweepNow);

module.exports = router;
