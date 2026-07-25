"use strict";

const svc = require("../services/recuperable.service");
const { toFicheResponse, toFicheList } = require("../dto/recuperable.dto");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("Recuperable error:", err);
  res.status(status).json({
    success: false,
    message: err.message || "Internal server error",
  });
}

function actorFrom(req) {
  return { id: req.user.sub, role: req.user.role };
}

async function saveFiche(req, res) {
  try {
    const data = await svc.saveFiche(req.body, actorFrom(req));
    res.status(201).json({ success: true, data: toFicheResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function listFiches(req, res) {
  try {
    const { module, machine, ligne, poste, statut } = req.query;
    const data = await svc.listFiches({ module, machine, ligne, poste, statut }, actorFrom(req));
    res.json({ success: true, count: data.length, data: toFicheList(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function getFiche(req, res) {
  try {
    const data = await svc.getFicheById(req.params.id, actorFrom(req));
    res.json({ success: true, data: toFicheResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function terminerFiche(req, res) {
  try {
    const data = await svc.terminerFiche(req.params.id, actorFrom(req));
    res.json({ success: true, data: toFicheResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function deleteFiche(req, res) {
  try {
    await svc.deleteFiche(req.params.id, actorFrom(req));
    res.json({ success: true });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = { saveFiche, listFiches, getFiche, terminerFiche, deleteFiche };
