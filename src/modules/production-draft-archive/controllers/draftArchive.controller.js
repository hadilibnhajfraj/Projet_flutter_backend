"use strict";

const draftArchive = require("../services/draftArchive.service");
const requests = require("../services/unarchiveRequests.service");
const compliance = require("../../production-compliance/services/compliance.service");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("[production-draft-archive] error:", err);
  res.status(status).json({
    success: false,
    ...(err.code ? { code: err.code } : {}),
    message: err.message || "Internal server error",
  });
}

// Réservé aux responsables (mêmes comptes que le contrôle de production) —
// vérifié en base à chaque appel, jamais seulement le JWT.
const requireManager = async (req, res, next) => {
  try {
    const user = await compliance.findUserByEmail(req.user?.email);
    const isManager = !!user && user.id === req.user.sub && user.isActive !== false && compliance.isComplianceManagerUser(user);
    logger.info(`[PRODUCTION-DRAFT-ARCHIVE ACCESS] email: ${req.user?.email || "-"} | role: ${user?.role || "-"} | access: ${isManager ? "GRANTED" : "DENIED"}`);
    if (!isManager) {
      return res.status(403).json({ success: false, code: "NOT_A_MANAGER", message: "Only a production compliance manager can access this." });
    }
    return next();
  } catch (err) {
    return handle(res, err);
  }
};

// ── Demande de désarchivage (propriétaire de la fiche) ──────────────────
const createRequest = async (req, res) => {
  try {
    const { ficheType, ficheId, reason } = req.body || {};
    const out = await requests.createUnarchiveRequest({ userId: req.user.sub, email: req.user.email, ficheType, ficheId, reason });
    res.status(out.alreadyPending ? 200 : 201).json({ success: true, data: out.request, alreadyPending: out.alreadyPending });
  } catch (err) {
    handle(res, err);
  }
};

const myRequests = async (req, res) => {
  try {
    res.json({ success: true, data: await requests.myRequests(req.user.sub) });
  } catch (err) {
    handle(res, err);
  }
};

// ── Responsables ──────────────────────────────────────────────────────────
const listRequests = async (req, res) => {
  try {
    const { status, ficheType, userId } = req.query;
    const data = await requests.listRequests({ status, ficheType, userId });
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
};

const requestStats = async (req, res) => {
  try {
    res.json({ success: true, data: await requests.requestStats() });
  } catch (err) {
    handle(res, err);
  }
};

const approveRequest = async (req, res) => {
  try {
    const out = await requests.approveUnarchiveRequest({ managerId: req.user.sub, id: req.params.id, note: req.body?.note });
    res.json({ success: true, data: out.request });
  } catch (err) {
    handle(res, err);
  }
};

const rejectRequest = async (req, res) => {
  try {
    const out = await requests.rejectUnarchiveRequest({ managerId: req.user.sub, id: req.params.id, note: req.body?.note });
    res.json({ success: true, data: out.request });
  } catch (err) {
    handle(res, err);
  }
};

// ── Déclenchement manuel du sweep (diagnostic responsable) ───────────────
const runSweepNow = async (req, res) => {
  try {
    res.json({ success: true, data: await draftArchive.sweepDraftArchive() });
  } catch (err) {
    handle(res, err);
  }
};

// ── §12 : liste directe des fiches ACTUELLEMENT archivées (distinct des
// demandes de désarchivage — une fiche archivée peut n'avoir aucune demande
// en cours, ce qui est normal et ne signifie pas qu'elle n'est pas archivée).
const listArchivedSheets = async (req, res) => {
  try {
    const { ficheType } = req.query;
    res.json({ success: true, data: await draftArchive.listArchivedSheets({ ficheType }) });
  } catch (err) {
    handle(res, err);
  }
};

module.exports = { requireManager, createRequest, myRequests, listRequests, requestStats, approveRequest, rejectRequest, runSweepNow, listArchivedSheets };
