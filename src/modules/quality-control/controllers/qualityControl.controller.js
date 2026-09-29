"use strict";

const svc = require("../services/qualityControl.service");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("[quality-control] error:", err);
  res.status(status).json({
    success: false,
    ...(err.code ? { code: err.code } : {}),
    message: err.message || "Internal server error",
    ...(err.errors ? { errors: err.errors } : {}),
  });
}

// Utilisateur connecté issu du JWT (authRequired) — seule source de
// l'identité du contrôleur, jamais le corps de la requête.
function actorFrom(req) {
  return { id: req.user.sub, role: req.user.role, email: req.user.email };
}

const wrap = (fn, status = 200) => async (req, res) => {
  try {
    res.status(status).json({ success: true, data: await fn(req) });
  } catch (err) {
    handle(res, err);
  }
};

const listParameters = wrap(() => svc.listParameters());

const listControls = async (req, res) => {
  try {
    const { status, productionType, machine, poste, from, to, search, page, limit } = req.query;
    const { data, pagination } = await svc.listControls({ status, productionType, machine, poste, from, to, search, page, limit }, actorFrom(req));
    res.json({ success: true, data, pagination });
  } catch (err) {
    handle(res, err);
  }
};

const listByProductionRecord = wrap((req) => svc.listByProductionRecord(req.params.productionRecordId, req.query.productionType, actorFrom(req)));
const getControl = wrap((req) => svc.getControlById(req.params.id, actorFrom(req)));
const createControl = wrap((req) => svc.createControl(req.body, actorFrom(req)), 201);
const updateControl = wrap((req) => svc.updateControl(req.params.id, req.body, actorFrom(req)));
const validateControl = wrap((req) => svc.validateControl(req.params.id, req.body, actorFrom(req)));
const deleteControl = wrap((req) => svc.deleteControl(req.params.id, actorFrom(req)));

module.exports = {
  listParameters,
  listControls,
  listByProductionRecord,
  getControl,
  createControl,
  updateControl,
  validateControl,
  deleteControl,
};
