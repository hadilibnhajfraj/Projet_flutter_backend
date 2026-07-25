"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/maintenanceRequest.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireMaintenanceManager } = require("../../../middleware/requireMaintenanceManager");
const { maintenanceRequestUpload } = require("../../../middleware/maintenanceRequestUpload.middleware");

router.use(authRequired);

// ── Accessible à tout utilisateur authentifié ─────────────
router.get("/my", ctrl.getMyRequests);
router.post("/", maintenanceRequestUpload.array("photos", 5), ctrl.createRequest);

// ── Réservé aux gestionnaires (admin/superadmin/superadmin2/responsable_logistique_achat) ──
router.get("/technicians", requireMaintenanceManager, ctrl.getTechnicians);
router.get("/", requireMaintenanceManager, ctrl.getAllRequests);
router.get("/stats", requireMaintenanceManager, ctrl.getStats);
router.put("/:id/accept", requireMaintenanceManager, ctrl.acceptRequest);
router.put("/:id/reject", requireMaintenanceManager, ctrl.rejectRequest);
router.put("/:id/assign", requireMaintenanceManager, ctrl.assignTechnician);
router.put("/:id/start", requireMaintenanceManager, ctrl.startRequest);
router.put("/:id/complete", requireMaintenanceManager, ctrl.completeRequest);
router.delete("/:id", requireMaintenanceManager, ctrl.deleteRequest);

// ── Per-request sub-routes (accès propriétaire-ou-gestionnaire vérifié dans le service) ──
router.get("/:id/comments", ctrl.getComments);
router.post("/:id/comments", ctrl.addComment);
router.get("/:id/history", ctrl.getHistory);
router.get("/:id", ctrl.getById);

module.exports = router;
