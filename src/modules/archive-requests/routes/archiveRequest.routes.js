"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/archiveRequest.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRootAdmin } = require("../../../middleware/requireRootAdmin");

router.use(authRequired);

// Static named routes first — before :id param
router.get("/debug", (req, res) => res.json({ user: req.user }));

// ── Accessible à tout utilisateur authentifié ─────────────
router.get("/my", ctrl.getMyRequests);
router.get("/pending-count", ctrl.getPendingCount);
router.post("/", ctrl.createRequest);

// ── Réservé au root-admin (cbitunisia@cbi-tunisia.com) ────
router.get("/", requireRootAdmin, ctrl.getAllRequests);
router.get("/admin", requireRootAdmin, ctrl.getAdminRequests);
router.get("/pending", requireRootAdmin, ctrl.getPendingRequests);
router.get("/stats", requireRootAdmin, ctrl.getStats);
router.put("/:id/approve", requireRootAdmin, ctrl.approveRequest);
router.put("/:id/reject", requireRootAdmin, ctrl.rejectRequest);
router.delete("/:id", requireRootAdmin, ctrl.deleteRequest);

// ── Per-request sub-routes (accès vérifié dans le service) ─
router.get("/:id/messages", ctrl.getMessages);
router.post("/:id/messages", ctrl.addMessage);

module.exports = router;
