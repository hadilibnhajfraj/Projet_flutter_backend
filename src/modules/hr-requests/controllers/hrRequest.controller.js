"use strict";

const svc = require("../services/hrRequest.service");
const { toHrRequestResponse, toHrRequestList } = require("../dto/hrRequest.dto");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("HrRequest error:", err);
  res.status(status).json({
    success: false,
    message: err.message || "Internal server error",
  });
}

function actorFrom(req) {
  return { id: req.user.sub, role: req.user.role, email: req.user.email };
}

async function createRequest(req, res) {
  try {
    const photoPaths = (req.files || []).map((f) => `/uploads/hr-requests/${f.filename}`);
    const data = await svc.createRequest(req.body, actorFrom(req), photoPaths);
    res.status(201).json({ success: true, data: toHrRequestResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function listRequests(req, res) {
  try {
    const { type, statut } = req.query;
    const data = await svc.listRequests({ type, statut }, actorFrom(req));
    res.json({ success: true, count: data.length, data: toHrRequestList(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function getRequest(req, res) {
  try {
    const data = await svc.getRequestById(req.params.id, actorFrom(req));
    res.json({ success: true, data: toHrRequestResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function acceptRequest(req, res) {
  try {
    const data = await svc.acceptRequest(req.params.id, actorFrom(req), req.body.comment || null);
    res.json({ success: true, data: toHrRequestResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function rejectRequest(req, res) {
  try {
    const data = await svc.rejectRequest(req.params.id, actorFrom(req), req.body.comment || null);
    res.json({ success: true, data: toHrRequestResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function markProcessed(req, res) {
  try {
    const data = await svc.markProcessed(req.params.id, actorFrom(req));
    res.json({ success: true, data: toHrRequestResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function addComment(req, res) {
  try {
    if (!req.body.comment || !String(req.body.comment).trim()) {
      return res.status(400).json({ success: false, message: "comment est requis" });
    }
    const data = await svc.addComment(req.params.id, actorFrom(req), String(req.body.comment).trim());
    res.json({ success: true, data: toHrRequestResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function getHistory(req, res) {
  try {
    const data = await svc.getHistory(req.params.id, actorFrom(req));
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function deleteRequest(req, res) {
  try {
    await svc.deleteRequest(req.params.id, actorFrom(req));
    res.json({ success: true });
  } catch (err) {
    handle(res, err);
  }
}

async function getPdf(req, res) {
  try {
    const doc = await svc.getHrRequestPdf(req.params.id, actorFrom(req));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="demande-rh-${req.params.id}.pdf"`);
    doc.pipe(res);
  } catch (err) {
    handle(res, err);
  }
}

module.exports = {
  createRequest,
  listRequests,
  getRequest,
  acceptRequest,
  rejectRequest,
  markProcessed,
  addComment,
  getHistory,
  deleteRequest,
  getPdf,
};
