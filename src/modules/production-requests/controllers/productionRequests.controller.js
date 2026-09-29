"use strict";

const svc = require("../services/productionRequests.service");
const compliance = require("../../production-compliance/services/compliance.service");
const { ALL_PERMISSIONS } = require("../../../config/productionWorkflow");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("[production-requests] error:", err);
  res.status(status).json({ success: false, ...(err.code ? { code: err.code } : {}), message: err.message || "Internal server error" });
}

// Consultation tracée (§11) — n'échoue jamais la réponse si l'audit échoue.
function audit(req, action, extra) {
  svc.recordView(req.productionActor, action, extra).catch((err) => logger.error(`[production-requests] audit ${action} échoué: ${err.message}`));
}

// Permissions production.* effectives de l'utilisateur connecté (relu en
// base) — permet au front d'afficher les menus sans deviner ; le backend
// revérifie de toute façon chaque route.
const myPermissions = async (req, res) => {
  try {
    const user = await compliance.findUserByEmail(req.user?.email);
    const valid = !!user && user.id === req.user.sub && user.isActive !== false;
    const permissions = valid ? ALL_PERMISSIONS.filter((p) => compliance.hasProductionPermission(user, p)) : [];
    res.json({ success: true, data: { permissions } });
  } catch (err) {
    handle(res, err);
  }
};

const statistics = async (req, res) => {
  try {
    const data = await svc.getStatistics(req.query);
    audit(req, "VIEW_STATISTICS", { details: data.filters });
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
};

const history = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.getHistory(req.query) });
  } catch (err) {
    handle(res, err);
  }
};

const requestHistory = async (req, res) => {
  try {
    const data = await svc.getRequestHistory(req.params.type, req.params.id);
    audit(req, "VIEW_HISTORY", { requestType: data.request.type, requestId: data.request.id });
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
};

const auditLog = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.listAudit(req.query) });
  } catch (err) {
    handle(res, err);
  }
};

module.exports = { myPermissions, statistics, history, requestHistory, auditLog };
