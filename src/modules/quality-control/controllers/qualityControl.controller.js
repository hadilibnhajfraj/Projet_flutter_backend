"use strict";

const svc = require("../services/qualityControl.service");
const reports = require("../services/qualityControlReports.service");
const comparisons = require("../services/qualityControlComparison.service");
const files = require("../services/qualityControlExport");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("[quality-control] error:", err);
  res.status(status).json({
    success: false,
    ...(err.code ? { code: err.code } : {}),
    message: err.message || "Internal server error",
    ...(err.errors ? { errors: err.errors } : {}),
    ...(err.existingId ? { existingId: err.existingId } : {}),
    ...(err.existingReadingId ? { existingReadingId: err.existingReadingId } : {}),
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
const getConfig = wrap(() => svc.getConfig());
const getStats = wrap((req) => svc.getStats({ period: req.query.period }, actorFrom(req)));

const listControls = async (req, res) => {
  try {
    const { status, productionType, machine, poste, from, to, period, search, page, limit } = req.query;
    const { data, pagination } = await svc.listControls(
      { status, productionType, machine, poste, from, to, period, search, page, limit },
      actorFrom(req)
    );
    res.json({ success: true, data, pagination });
  } catch (err) {
    handle(res, err);
  }
};

// ── Export Historique / Comparaison (fichiers) ──────────────────────────

const MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
};

function sendFile(res, buffer, format, name) {
  res.setHeader("Content-Type", MIME[format]);
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.send(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

function format(req, allowed) {
  const f = String(req.query.format || "xlsx").toLowerCase();
  if (!allowed.includes(f)) throw { status: 400, code: "INVALID_FORMAT", message: `Format invalide (${allowed.join(", ")})` };
  return f;
}

// Mêmes filtres que GET /quality-control (Historique) : export = données filtrées.
const exportHistory = async (req, res) => {
  try {
    const fmt = format(req, ["xlsx", "pdf", "csv"]);
    const data = await reports.exportData(req.query, actorFrom(req));
    const build = { xlsx: files.buildHistoryExcel, pdf: files.buildHistoryPdf, csv: files.buildHistoryCsv }[fmt];
    sendFile(res, await build(data), fmt, files.historyFileName(data.filters, fmt));
  } catch (err) {
    handle(res, err);
  }
};

const comparison = wrap((req) => comparisons.comparison(req.query, actorFrom(req)));

const exportComparison = async (req, res) => {
  try {
    const fmt = format(req, ["xlsx", "pdf"]);
    const data = await comparisons.comparison(req.query, actorFrom(req));
    const build = fmt === "pdf" ? files.buildComparisonPdf : files.buildComparisonExcel;
    sendFile(res, await build(data), fmt, files.comparisonFileName(data, fmt));
  } catch (err) {
    handle(res, err);
  }
};

const productionMatch = wrap((req) => svc.productionMatch(req.matchQuery));
const listByProductionRecord = wrap((req) => svc.listByProductionRecord(req.params.productionRecordId, req.query.productionType, actorFrom(req)));
const getControl = wrap((req) => svc.getControlById(req.params.id, actorFrom(req)));
const createControl = wrap((req) => svc.createControl(req.body, actorFrom(req)), 201);
const updateControl = wrap((req) => svc.updateControl(req.params.id, req.body, actorFrom(req)));
const validateControl = wrap((req) => svc.validateControl(req.params.id, req.body, actorFrom(req)));
const deleteControl = wrap((req) => svc.deleteControl(req.params.id, actorFrom(req)));

const createReading = wrap((req) => svc.createReading(req.params.id, req.body, actorFrom(req)), 201);
const updateReading = wrap((req) => svc.updateReading(req.params.id, req.params.readingId, req.body, actorFrom(req)));
const validateReading = wrap((req) => svc.validateReading(req.params.id, req.params.readingId, req.body, actorFrom(req)));
const deleteReading = wrap((req) => svc.deleteReading(req.params.id, req.params.readingId, actorFrom(req)));

module.exports = {
  listParameters,
  getConfig,
  getStats,
  exportHistory,
  comparison,
  exportComparison,
  listControls,
  productionMatch,
  listByProductionRecord,
  getControl,
  createControl,
  updateControl,
  validateControl,
  deleteControl,
  createReading,
  updateReading,
  validateReading,
  deleteReading,
};
