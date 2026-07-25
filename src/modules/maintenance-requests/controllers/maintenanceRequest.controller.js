"use strict";

const svc = require("../services/maintenanceRequest.service");
const { resolveFullName } = require("../../../utils/userDisplay");
require("../../../models/associations");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error("MaintenanceRequest error:", err);
  res.status(status).json({ success: false, message: err.message || "Internal server error" });
}

// ── Response normalizer — forme JSON stable pour Flutter ──

function normalizeRequest(r) {
  const j = r.toJSON ? r.toJSON() : r;
  const requester = j.requester || null;
  const technician = j.technician || null;

  return {
    id: j.id,
    ticketNo: j.ticketNo,
    equipement: j.equipement,
    typePanne: j.typePanne,
    urgence: j.urgence,
    description: j.description,
    photos: j.photos || [],
    statut: j.statut,
    rejectionReason: j.rejectionReason || null,
    processedAt: j.processedAt || null,
    assignedAt: j.assignedAt || null,
    startedAt: j.startedAt || null,
    completedAt: j.completedAt || null,
    userId: j.userId,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    requester: {
      id: requester?.id || j.userId || null,
      email: requester?.email || "—",
      name: requester ? resolveFullName(requester) : "Utilisateur",
    },
    technician: technician
      ? { id: technician.id, email: technician.email, name: resolveFullName(technician) }
      : null,
  };
}

// ── POST /maintenance-requests ────────────────────────────

async function createRequest(req, res) {
  try {
    const { equipement, typePanne, urgence, description } = req.body;
    if (!equipement || !typePanne) {
      return res.status(400).json({ success: false, message: "equipement et typePanne sont requis" });
    }

    const photoPaths = (req.files || []).map((f) => `/uploads/maintenance-requests/${f.filename}`);

    const request = await svc.createRequest(
      req.user.sub,
      { equipement, typePanne, urgence, description },
      photoPaths
    );
    const full = await svc.getById(req.user.sub, req.user.role, request.id);
    res.status(201).json({ success: true, data: normalizeRequest(full) });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /maintenance-requests/my ──────────────────────────

async function getMyRequests(req, res) {
  try {
    const requests = await svc.getMyRequests(req.user.sub);
    res.json({ success: true, count: requests.length, data: requests.map(normalizeRequest) });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /maintenance-requests ─────────────────────────────

async function getAllRequests(req, res) {
  try {
    const { statut, urgence, search } = req.query;
    const requests = await svc.getAllRequests({ statut, urgence, search });
    res.json({ success: true, count: requests.length, data: requests.map(normalizeRequest) });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /maintenance-requests/stats ───────────────────────

async function getStats(req, res) {
  try {
    const stats = await svc.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /maintenance-requests/technicians ─────────────────

async function getTechnicians(req, res) {
  try {
    const technicians = await svc.getTechnicians();
    res.json({ success: true, data: technicians });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /maintenance-requests/:id ─────────────────────────

async function getById(req, res) {
  try {
    const request = await svc.getById(req.user.sub, req.user.role, req.params.id, req.user.email);
    res.json({ success: true, data: normalizeRequest(request) });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /maintenance-requests/:id/accept ──────────────────

async function acceptRequest(req, res) {
  try {
    await svc.acceptRequest(req.user.sub, req.params.id);
    res.json({ success: true, statut: "acceptee" });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /maintenance-requests/:id/reject ──────────────────

async function rejectRequest(req, res) {
  try {
    await svc.rejectRequest(req.user.sub, req.params.id, req.body.reason || null);
    res.json({ success: true, statut: "refusee" });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /maintenance-requests/:id/assign ──────────────────

async function assignTechnician(req, res) {
  try {
    const { technicianId } = req.body;
    if (!technicianId) return res.status(400).json({ success: false, message: "technicianId est requis" });
    await svc.assignTechnician(req.user.sub, req.params.id, technicianId);
    res.json({ success: true });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /maintenance-requests/:id/start ───────────────────

async function startRequest(req, res) {
  try {
    await svc.startRequest(req.user.sub, req.params.id);
    res.json({ success: true, statut: "en_cours" });
  } catch (err) {
    handle(res, err);
  }
}

// ── PUT /maintenance-requests/:id/complete ────────────────

async function completeRequest(req, res) {
  try {
    await svc.completeRequest(req.user.sub, req.params.id);
    res.json({ success: true, statut: "terminee" });
  } catch (err) {
    handle(res, err);
  }
}

// ── DELETE /maintenance-requests/:id ──────────────────────

async function deleteRequest(req, res) {
  try {
    await svc.deleteRequest(req.params.id);
    res.json({ success: true });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET/POST /maintenance-requests/:id/comments ───────────

async function getComments(req, res) {
  try {
    const data = await svc.getComments(req.user.sub, req.user.role, req.params.id, req.user.email);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function addComment(req, res) {
  try {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: "message est requis" });
    }
    const data = await svc.addComment(req.user.sub, req.params.id, String(message).trim());
    res.status(201).json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /maintenance-requests/:id/history ─────────────────

async function getHistory(req, res) {
  try {
    const data = await svc.getHistory(req.user.sub, req.user.role, req.params.id, req.user.email);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = {
  createRequest,
  getMyRequests,
  getAllRequests,
  getStats,
  getTechnicians,
  getById,
  acceptRequest,
  rejectRequest,
  assignTechnician,
  startRequest,
  completeRequest,
  deleteRequest,
  getComments,
  addComment,
  getHistory,
};
