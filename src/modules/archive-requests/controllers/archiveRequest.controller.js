"use strict";

const ArchiveRequest = require("../../../models/ArchiveRequest");
const Project = require("../../../models/Project");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

const svc = require("../services/archiveRequest.service");
const { ROOT_ADMIN_EMAIL } = require("../../../config/rootAdmin");

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
  attributes: ["id", "email", "role"],
  include: [{ model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false }],
  required: false,
};

const PROJECT_INCLUDE = {
  model: Project,
  as: "archiveProject",
  // Real DB columns — nomProjet is the project name field
  attributes: ["id", "nomProjet", "comptoir", "isArchived", "archiveReason"],
  required: false,
};

// ── Response normalizer ───────────────────────────────────
// Maps DB shape → shape Flutter expects (projectName, requester.name)

function normalizeRequest(r) {
  const j = r.toJSON ? r.toJSON() : r;
  const p = j.archiveProject || null;
  const u = j.requester || null;
  const profile = u?.profile || {};

  // Build display name from UserProfile.name (User has no name/firstName/lastName columns)
  const displayName = profile.name || u?.email || "Utilisateur";

  const normalized = {
    id:        j.id,
    subject:   j.subject,
    message:   j.message,
    status:    j.status,
    type:      j.type || "DESARCHIVAGE",
    rejectionReason: j.rejectionReason || null,
    projectId: j.projectId,
    userId:    j.userId,
    adminId:   j.adminId,
    approvedBy: j.approvedBy || null,
    approvedAt: j.approvedAt || null,
    rejectedBy: j.rejectedBy || null,
    rejectedAt: j.rejectedAt || null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,

    archiveProject: p ? {
      id:          p.id,
      nomProjet:   p.nomProjet,
      projectName: p.nomProjet || p.comptoir || "Projet inconnu",
      name:        p.nomProjet || p.comptoir || "Projet inconnu",
      societe:     p.comptoir || null,
      isArchived:  p.isArchived,
      archiveReason: p.archiveReason,
    } : null,

    // Always non-null — fallback to userId so Flutter never sees null requester
    requester: {
      id:        u?.id    || j.userId || null,
      email:     u?.email || "—",
      name:      displayName,
      firstName: displayName,
      lastName:  "",
      avatarUrl: profile.avatarUrl || null,
    },
  };

  return normalized;
}

// ── POST /archive-requests ────────────────────────────────

async function createRequest(req, res) {
  try {
    const { projectId, projectName, subject, message, reason, type } = req.body;
    const requestType = type === "ARCHIVAGE" ? "ARCHIVAGE" : "DESARCHIVAGE";
    const label = requestType === "ARCHIVAGE" ? "archivage" : "désarchivage";

    const finalSubject = subject || `Demande de ${label} - ${projectName || "Projet"}`;
    const finalMessage = message || reason;

    if (!projectId || !finalSubject || !finalMessage) {
      return res.status(400).json({ success: false, message: "projectId, subject et message sont requis" });
    }

    const request = await svc.createRequest(req.user.sub, {
      projectId,
      subject: finalSubject,
      message: finalMessage,
      type: requestType,
    });
    res.status(201).json({ success: true, data: request });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ success: false, message: err.message, requestId: err.requestId || null });
    }
    handle(res, err);
  }
}

// ── GET /archive-requests  (root-admin: toutes les demandes assignées) ──

async function getAllRequests(req, res) {
  try {
    const requests = await ArchiveRequest.findAll({
      where: { adminId: req.user.sub },
      include: [REQUESTER_INCLUDE, PROJECT_INCLUDE],
      order: [["createdAt", "DESC"]],
    });

    return res.json({ success: true, count: requests.length, data: requests.map(normalizeRequest) });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/my ──────────────────────────────
// Root-admin  → requests assigned to them (adminId)
// Regular user → requests they submitted (userId)

async function getMyRequests(req, res) {
  try {
    const currentUserId = req.user.id || req.user.sub;
    const isRootAdmin = (req.user?.email || "").toLowerCase().trim() === ROOT_ADMIN_EMAIL;

    let requests;

    if (isRootAdmin) {
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

    return res.status(200).json(requests.map(normalizeRequest));
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/admin ───────────────────────────

async function getAdminRequests(req, res) {
  try {
    const requests = await svc.getAdminRequests(req.user.sub, req.query.status || null);
    res.json({ success: true, count: requests.length, data: requests.map(normalizeRequest) });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/pending ────────────────────────

async function getPendingRequests(req, res) {
  try {
    const requests = await ArchiveRequest.findAll({
      where: { adminId: req.user.sub, status: "pending" },
      include: [REQUESTER_INCLUDE, PROJECT_INCLUDE],
      order: [["createdAt", "DESC"]],
    });

    res.json({ success: true, count: requests.length, data: requests.map(normalizeRequest) });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/stats ──────────────────────────

async function getStats(req, res) {
  try {
    const stats = await svc.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/pending-count ──────────────────
// Utilisé par le badge sidebar — accessible à tout utilisateur authentifié,
// mais ne renvoie un compte réel que pour le root-admin (sinon 0), pour ne
// jamais révéler l'existence de demandes à un utilisateur non autorisé.

async function getPendingCount(req, res) {
  try {
    const isRootAdmin = (req.user?.email || "").toLowerCase().trim() === ROOT_ADMIN_EMAIL;
    const count = isRootAdmin ? await svc.getPendingCount() : 0;
    res.json({ success: true, count });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /archive-requests/:id/messages ───────────────────

async function getMessages(req, res) {
  try {
    const data = await svc.getMessages(req.params.id, req.user.sub, req.user.email);
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
    await svc.approveRequest(req.user.sub, req.params.id);
    res.json({ success: true, status: "approved" });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /archive-requests/:id/reject ─────────────────────

async function rejectRequest(req, res) {
  try {
    await svc.rejectRequest(req.user.sub, req.params.id, req.body.reason || null);
    res.json({ success: true, status: "rejected" });
  } catch (err) {
    handle(res, err);
  }
}

// ── DELETE /archive-requests/:id ─────────────────────────

async function deleteRequest(req, res) {
  try {
    await svc.deleteRequest(req.params.id);
    res.json({ success: true });
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
  getStats,
  getPendingCount,
  getMessages,
  addMessage,
  approveRequest,
  rejectRequest,
  deleteRequest,
};
