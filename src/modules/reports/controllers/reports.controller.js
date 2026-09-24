"use strict";

const svc = require("../services/reports.service");
const { buildExcel, buildPdf } = require("../services/reportsExport");
const { makeT } = require("../services/reportsI18n");
const logger = require("../../../utils/logger");

const wrap = (fn) => async (req, res) => {
  try {
    const f = svc.parseFilters(req.query);
    const data = await fn(f, req);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
    logger.error(`[REPORTS] ${req.originalUrl}: ${err.stack || err.message}`);
    res.status(500).json({ success: false, message: "Report generation failed" });
  }
};

// Vérifie qu'un buffer est bien un PDF complet (en-tête + marqueur de fin).
function assertValidPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1000) throw Object.assign(new Error(`PDF buffer too small (${buf?.length ?? 0} bytes)`), { stage: "buffer" });
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") throw Object.assign(new Error("PDF header missing"), { stage: "buffer" });
  if (!buf.slice(-1024).toString("latin1").includes("%%EOF")) throw Object.assign(new Error("PDF truncated (no %%EOF)"), { stage: "buffer" });
}

const exporter = (kind, build, mime, ext) => async (req, res) => {
  const tag = `[REPORTS][export:${kind}]`;
  const started = Date.now();
  let stage = "params";
  let f;
  try {
    f = svc.parseFilters(req.query);
    stage = "data";
    const data = await svc.fullReport(f);
    logger.info(`${tag} data ready in ${Date.now() - started}ms`);

    stage = "render";
    const buf = Buffer.from(await build(data, f));
    logger.info(`${tag} rendered ${buf.length} bytes in ${Date.now() - started}ms`);

    stage = "buffer";
    if (kind === "pdf") assertValidPdf(buf);

    stage = "http";
    const filename = `rapport-pilotage-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.${ext}`;
    res.status(200);
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length");
    res.on("close", () => {
      if (!res.writableFinished) logger.warn(`${tag} connection closed before the response was fully sent`);
    });
    res.end(buf);
    logger.info(`${tag} sent ${filename} (${buf.length} bytes) total ${Date.now() - started}ms`);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, stage: "params", message: err.message });
    logger.error(`${tag} failed at stage=${err.stage || stage}: ${err.stack || err.message}`);
    if (res.headersSent) return res.end();
    const t = makeT(f?.lang);
    res.status(500).json({ success: false, stage: err.stage || stage, message: t(kind === "pdf" ? "errPdf" : "errExcel") });
  }
};

module.exports = {
  filters: wrap(() => svc.filterOptions()),
  overview: wrap((f) => svc.overview(f)),
  commercials: wrap((f) => svc.commercials(f)),
  projects: wrap((f, req) => svc.projects(f, { limit: req.query.limit, offset: req.query.offset })),
  archived: wrap((f, req) => svc.projects(f, { archivedOnly: true, limit: req.query.limit, offset: req.query.offset })),
  contacts: wrap((f) => svc.contacts(f)),
  users: wrap((f) => svc.users(f)),
  userDetail: async (req, res) => {
    try {
      const f = svc.parseFilters(req.query);
      const data = await svc.userDetail(req.params.id, f);
      if (!data) return res.status(404).json({ success: false, message: "User not found" });
      res.json({ success: true, data });
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
      logger.error(`[REPORTS] user detail: ${err.stack || err.message}`);
      res.status(500).json({ success: false, message: "Report generation failed" });
    }
  },
  activity: wrap((f, req) => svc.activity(f, { limit: req.query.limit, offset: req.query.offset, module: req.query.activityModule })),
  industrial: wrap((f) => svc.industrial(f)),
  machines: wrap((f) => svc.machines(f)),
  production: wrap((f) => svc.production(f)),
  dataQuality: wrap((f) => svc.dataQuality(f)),
  recommendations: wrap(async (f) => ({ ...(await svc.insights(f)), capabilities: svc.capabilities() })),
  exportExcel: exporter("excel", buildExcel, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
  exportPdf: exporter("pdf", buildPdf, "application/pdf", "pdf"),
};
