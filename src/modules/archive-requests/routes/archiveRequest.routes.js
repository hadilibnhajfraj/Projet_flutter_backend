"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/archiveRequest.controller");
const { authRequired } = require("../../../middleware/auth.middleware");

router.use(authRequired);

// Static named routes first — before :id param
router.get("/debug",   (req, res) => res.json({ user: req.user }));
router.get("/",        ctrl.getAllRequests);
router.get("/my",      ctrl.getMyRequests);
router.get("/admin",   ctrl.getAdminRequests);
router.get("/pending", ctrl.getPendingRequests);

// Request lifecycle
router.post("/", ctrl.createRequest);

// Per-request sub-routes
router.get("/:id/messages",  ctrl.getMessages);
router.post("/:id/messages", ctrl.addMessage);
router.put("/:id/approve",   ctrl.approveRequest);
router.put("/:id/reject",    ctrl.rejectRequest);

module.exports = router;
