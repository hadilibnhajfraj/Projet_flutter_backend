"use strict";

const fs = require("fs");
const svc = require("../services/calculationNote.service");
const logger = require("../../../utils/logger");

// Réponse d'erreur uniforme ({ success:false, code, message }) ; jamais de
// jeton ni de contenu de fichier dans les journaux.
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof svc.HttpError) {
        return res.status(e.status).json({ success: false, code: e.code, message: e.message, ...e.extra });
      }
      logger.error("[CALCULATION NOTES]", { path: req.originalUrl.split("?")[0], method: req.method, userId: req.user?.sub || null, error: e.message });
      return res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Erreur serveur." });
    }
  };
}

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// RFC 6266 : nom ASCII de repli + nom UTF-8 exact.
function contentDisposition(type, name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = {
  options: wrap(async (req, res) => ok(res, await svc.getOptions(req.user, req.query))),
  list: wrap(async (req, res) => {
    const r = await svc.listNotes(req.user, req.query);
    res.json({ success: true, ...r });
  }),
  get: wrap(async (req, res) => ok(res, await svc.getNote(req.user, req.params.id))),
  permissions: wrap(async (req, res) => ok(res, await svc.getPermissions(req.user))),
  validationQueue: wrap(async (req, res) => {
    const r = await svc.validationQueue(req.user, req.query);
    res.json({ success: true, ...r });
  }),
  validate: wrap(async (req, res) => ok(res, await svc.decide(req.user, req.params.id, "validate", req.body || {}))),
  reject: wrap(async (req, res) => ok(res, await svc.decide(req.user, req.params.id, "reject", req.body || {}))),
  cancel: wrap(async (req, res) => ok(res, await svc.cancelNote(req.user, req.params.id, req.body || {}))),
  resubmit: wrap(async (req, res) => ok(res, await svc.resubmitNote(req.user, req.params.id))),
  assignableUsers: wrap(async (req, res) => ok(res, await svc.assignableUsers(req.query))),
  addComplementary: wrap(async (req, res) => ok(res, await svc.addComplementaryDocuments(req.user, req.params.id, req.body || {}, req.files || []), 201)),
  setAssignment: wrap(async (req, res) => ok(res, await svc.setAssignment(req.user, req.params.id, req.body || {}))),
  assignments: wrap(async (req, res) => ok(res, await svc.getAssignments(req.user, req.params.id))),
  emailNotifications: wrap(async (req, res) => ok(res, await svc.getEmailNotifications(req.user, req.params.id))),
  resendEmails: wrap(async (req, res) => ok(res, await svc.resendFailedEmails(req.user, req.params.id))),
  history: wrap(async (req, res) => ok(res, await svc.getHistory(req.user, req.params.id))),
  create: wrap(async (req, res) => ok(res, await svc.createNote(req.user, req.body || {}, req.files || []), 201)),
  update: wrap(async (req, res) => ok(res, await svc.updateNote(req.user, req.params.id, req.body || {}))),
  addDocuments: wrap(async (req, res) => ok(res, await svc.addDocuments(req.user, req.params.id, req.body || {}, req.files || []), 201)),
  updateDocument: wrap(async (req, res) => ok(res, await svc.updateDocumentComment(req.user, req.params.id, req.params.docId, req.body || {}))),
  download: wrap(async (req, res) => {
    const { doc, fullPath } = await svc.getDocumentFile(req.user, req.params.id, req.params.docId);
    const stat = await fs.promises.stat(fullPath).catch(() => null);
    if (!stat) return res.status(404).json({ success: false, code: "FILE_MISSING", message: "Fichier introuvable sur le serveur." });
    // Aperçu en ligne uniquement pour le PDF ; Word/Excel toujours en pièce jointe.
    const inline = req.query.inline === "1" && doc.extension === "pdf";
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", doc.originalName));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(fullPath);
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(res);
    });
  }),
};
