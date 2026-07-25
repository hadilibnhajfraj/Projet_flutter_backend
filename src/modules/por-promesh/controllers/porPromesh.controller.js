"use strict";

const svc = require("../services/porPromesh.service");
const { toPorPromeshResponse, toPorPromeshList } = require("../dto/porPromesh.dto");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("PorPromesh error:", err);
  res.status(status).json({
    success: false,
    message: err.message || "Internal server error",
  });
}

function actorFrom(req) {
  // `email` est nécessaire au repli final de createOrOpenDraft (operateur ne
  // doit jamais être vide) — manquait ici, ce qui rendait inopérant le repli
  // `actor.email` malgré sa présence dans le JWT ({sub, email, role}).
  return { id: req.user.sub, role: req.user.role, email: req.user.email };
}

async function createPorPromesh(req, res) {
  try {
    const data = await svc.createPorPromesh(req.body, actorFrom(req));
    res.status(201).json({ success: true, data: toPorPromeshResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function createOrOpenDraft(req, res) {
  try {
    const { machine, poste, operateurName } = req.body;
    const report = await svc.createOrOpenDraft(actorFrom(req), { machine, poste, operateurName });
    res.status(201).json({
      success: true,
      data: { id: report.id, machine: report.machine, poste: report.poste, status: report.status },
    });
  } catch (err) {
    logger.error("[POR PROMESH] Erreur POST /por-promesh/new :", err.message);
    handle(res, err);
  }
}

async function listOperators(req, res) {
  try {
    const data = await svc.listOperators();
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function listPorPromesh(req, res) {
  try {
    const { machine, poste, date, dateRange, status, search, sort, page, pageSize, light } = req.query;
    const { data, total } = await svc.listPorPromesh(actorFrom(req), {
      machine,
      poste,
      date,
      dateRange,
      status,
      search,
      sort,
      page,
      pageSize,
      light,
    });
    res.json({ success: true, count: total, data: toPorPromeshList(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function getDashboard(req, res) {
  try {
    const { machine, poste, date, dateRange, status } = req.query;
    const data = await svc.getDashboard(actorFrom(req), { machine, poste, date, dateRange, status });
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function getStats(req, res) {
  try {
    const { machine, poste, date, dateRange, status } = req.query;
    const data = await svc.getStats(actorFrom(req), { machine, poste, date, dateRange, status });
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function getPorPromesh(req, res) {
  try {
    const data = await svc.getPorPromeshById(req.params.id, actorFrom(req));
    res.json({ success: true, data: toPorPromeshResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function updatePorPromesh(req, res) {
  try {
    const data = await svc.updatePorPromesh(req.params.id, req.body, actorFrom(req));
    res.json({ success: true, data: toPorPromeshResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function deletePorPromesh(req, res) {
  try {
    await svc.deletePorPromesh(req.params.id, actorFrom(req));
    res.json({ success: true });
  } catch (err) {
    handle(res, err);
  }
}

async function validatePorPromesh(req, res) {
  try {
    const data = await svc.validatePorPromesh(req.params.id, actorFrom(req));
    res.json({ success: true, data: toPorPromeshResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function addAttachment(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "Fichier requis" });
    const data = await svc.addAttachment(req.params.id, actorFrom(req), req.file);
    res.status(201).json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function getPorPromeshPdf(req, res) {
  try {
    const doc = await svc.getPorPromeshPdf(req.params.id, actorFrom(req));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="por-promesh-${req.params.id}.pdf"`);
    doc.pipe(res);
  } catch (err) {
    handle(res, err);
  }
}

module.exports = {
  createPorPromesh,
  createOrOpenDraft,
  listOperators,
  listPorPromesh,
  getDashboard,
  getStats,
  getPorPromesh,
  updatePorPromesh,
  deletePorPromesh,
  validatePorPromesh,
  addAttachment,
  getPorPromeshPdf,
};
