"use strict";

const ArchiveRequest = require("../../../models/ArchiveRequest");
const Project = require("../../../models/Project");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

const svc = require("../services/archiveRequest.service");

const ADMIN_ROLES = ["admin", "superadmin"];

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error("ArchiveRequest error:", err);
  res.status(status).json({
    success: false,
    message: err.message || "Internal server error",
    ...(err.requestId ? { requestId: err.requestId } : {}),
  });
}

// ── Shared include fragments (match associations.js aliases) ──

const REQUESTER_INCLUDE = {
  model: User,
  as: "requester",
  attributes: ["id", "email"],
  include: [{ model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false }],
  required: false,
};

const PROJECT_INCLUDE = {
  model: Project,
  as: "archiveProject",
  attributes: ["id", "nomProjet", "isArchived", "archiveReason"],
  required: false,
};

// ── POST /archive-requests ────────────────────────────────

async function createRequest(req, res) {
  try {
    const { projectId, projectName, subject, message, reason } = req.body;

    const finalSubject = subject || `Demande de désarchivage - ${projectName || "Projet"}`;
    const finalMessage = message || reason;

    console.log("ARCHIVE REQUEST BODY =", req.body);
    console.log("SUBJECT =", finalSubject);
    console.log("MESSAGE =", finalMessage);

    if (!projectId || !finalSubject || !finalMessage) {
      return res.status(400).json({ success: false, message: "projectId, subject et message sont requis" });
    }

    const request = await svc.createRequest(req.user.sub, {
      projectId,
      subject: finalSubject,
      message: finalMessage,
    });
    res.status(201).json({ success: true, data: request });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ success: false, message: err.message, requestId: err.requestId || null });
    }
    handle(res, err);
  }
}

// ── GET /archive-requests  (admin: toutes les demandes assignées) ──

async function getAllRequests(req, res) {
  try {
    console.log("ADMIN CONNECTED =", req.user.sub);
    console.log("ROLE =", req.user.role);

    if (!ADMIN_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: "Accès réservé aux administrateurs" });
    }

    const requests = await ArchiveRequest.findAll({
      where: { adminId: req.user.sub },
      include: [REQUESTER_INCLUDE, PROJECT_INCLUDE],
      order: [["createdAt", "DESC"]],
    });

    console.log("ARCHIVE REQUESTS =", requests.length);

    return res.json({ success: true, count: requests.length, data: requests });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/my ──────────────────────────────
// Admin/superadmin → requests assigned to them (adminId)
// Regular user     → requests they submitted (userId)

async function getMyRequests(req, res) {
  try {
    console.log("USER =", req.user);
    console.log("USER ID =", req.user.id);
    console.log("USER SUB =", req.user.sub);
    console.log("ROLE =", req.user.role);

    const currentUserId = req.user.id || req.user.sub;
    const isAdmin = ADMIN_ROLES.includes(req.user?.role);

    let requests;

    if (isAdmin) {
      requests = await ArchiveRequest.findAll({
        where: { adminId: currentUserId },
        include: [REQUESTER_INCLUDE, PROJECT_INCLUDE],
        order: [["createdAt", "DESC"]],
      });
    } else {
      requests = await ArchiveRequest.findAll({
        where: { userId: currentUserId },
        include: [PROJECT_INCLUDE],
        order: [["createdAt", "DESC"]],
      });
    }

    console.log("REQUESTS FOUND =", requests.length);

    return res.status(200).json(requests);
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/admin ───────────────────────────

async function getAdminRequests(req, res) {
  try {
    console.log("ADMIN USER =", req.user.sub);
    console.log("ADMIN ROLE =", req.user?.role);

    if (!ADMIN_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: "Accès réservé aux administrateurs" });
    }

    const requests = await svc.getAdminRequests(req.user.sub, req.query.status || null);

    console.log("REQUESTS FOUND =", requests.length);
    console.log(requests.map((r) => ({ id: r.id, projectId: r.projectId, userId: r.userId, status: r.status })));

    res.json({ success: true, count: requests.length, data: requests });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/pending ────────────────────────

async function getPendingRequests(req, res) {
  try {
    console.log("PENDING REQUESTS — ADMIN =", req.user.sub, "ROLE =", req.user?.role);

    if (!ADMIN_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: "Accès réservé aux administrateurs" });
    }

    const requests = await ArchiveRequest.findAll({
      where: { adminId: req.user.sub, status: "pending" },
      include: [REQUESTER_INCLUDE, PROJECT_INCLUDE],
      order: [["createdAt", "DESC"]],
    });

    console.log("PENDING REQUESTS FOUND =", requests.length);

    res.json({ success: true, count: requests.length, data: requests });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/:id/messages ───────────────────

async function getMessages(req, res) {
  try {
    const data = await svc.getMessages(req.params.id, req.user.sub, req.user.role);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// ── POST /archive-requests/:id/messages ──────────────────

async function addMessage(req, res) {
  try {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: "message est requis" });
    }
    const data = await svc.addMessage(req.user.sub, req.params.id, String(message).trim());
    res.status(201).json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /archive-requests/:id/approve ────────────────────

async function approveRequest(req, res) {
  try {
    if (!ADMIN_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: "Accès réservé aux administrateurs" });
    }
    const data = await svc.approveRequest(req.user.sub, req.params.id);
    res.json({ success: true, message: "Demande approuvée — projet désarchivé", data });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /archive-requests/:id/reject ─────────────────────

async function rejectRequest(req, res) {
  try {
    if (!ADMIN_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: "Accès réservé aux administrateurs" });
    }
    const data = await svc.rejectRequest(req.user.sub, req.params.id, req.body.reason || null);
    res.json({ success: true, message: "Demande refusée", data });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = {
  getAllRequests,
  createRequest,
  getMyRequests,
  getAdminRequests,
  getPendingRequests,
  getMessages,
  addMessage,
  approveRequest,
  rejectRequest,
};
