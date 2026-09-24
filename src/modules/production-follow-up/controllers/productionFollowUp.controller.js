"use strict";

const svc = require("../services/productionFollowUp.service");
const compliance = require("../../production-compliance/services/compliance.service");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("[production-follow-up] error:", err);
  res.status(status).json({ success: false, ...(err.code ? { code: err.code } : {}), message: err.message || "Internal server error" });
}

// Même garde que Production Compliance / Production Draft Archive (§16, §20 :
// réutilisation directe, jamais un 2e système de permissions).
const requireManager = async (req, res, next) => {
  try {
    const user = await compliance.findUserByEmail(req.user?.email);
    const isManager = !!user && user.id === req.user.sub && user.isActive !== false && compliance.isComplianceManagerUser(user);
    logger.info(`[PRODUCTION-FOLLOW-UP ACCESS] email: ${req.user?.email || "-"} | role: ${user?.role || "-"} | access: ${isManager ? "GRANTED" : "DENIED"}`);
    if (!isManager) {
      return res.status(403).json({ success: false, code: "NOT_A_MANAGER", message: "Only a production compliance manager can access this." });
    }
    return next();
  } catch (err) {
    return handle(res, err);
  }
};

const listAlerts = async (req, res) => {
  try {
    const { status, from, to } = req.query;
    const rows = await svc.listAlerts({ status, from, to });
    res.json({ success: true, data: rows });
  } catch (err) {
    handle(res, err);
  }
};

const retryEmail = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.retryEmail(req.params.id) });
  } catch (err) {
    handle(res, err);
  }
};

const ignoreAlert = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.ignoreAlert(req.params.id, { managerId: req.user.sub, reason: req.body?.reason }) });
  } catch (err) {
    handle(res, err);
  }
};

// Déclenchement manuel du balayage (diagnostic responsable).
const runSweepNow = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.sweepFollowUp() });
  } catch (err) {
    handle(res, err);
  }
};

module.exports = { requireManager, listAlerts, retryEmail, ignoreAlert, runSweepNow };
