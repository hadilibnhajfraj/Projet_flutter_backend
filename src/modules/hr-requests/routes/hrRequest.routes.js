"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/hrRequest.controller");
const { validateCreate } = require("../validators/hrRequest.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireHrReviewer } = require("../../../middleware/requireHrReviewer");
const { hrRequestUpload } = require("../../../middleware/hrRequestUpload.middleware");

// N'importe quel employé connecté peut créer/consulter ses propres demandes —
// seul le Responsable RH (admin/superadmin/superadmin2 ou
// manegerofficecbi@gmail.com) accepte/refuse/commente/marque traité.
router.use(authRequired);

router.post("/", hrRequestUpload.array("justificatifs", 5), validateCreate, ctrl.createRequest);
router.get("/", ctrl.listRequests);
router.get("/:id", ctrl.getRequest);
router.get("/:id/pdf", ctrl.getPdf);
router.get("/:id/history", ctrl.getHistory);
router.put("/:id/accept", requireHrReviewer, ctrl.acceptRequest);
router.put("/:id/reject", requireHrReviewer, ctrl.rejectRequest);
router.put("/:id/process", requireHrReviewer, ctrl.markProcessed);
router.put("/:id/comment", requireHrReviewer, ctrl.addComment);
router.delete("/:id", ctrl.deleteRequest);

module.exports = router;
