"use strict";

const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Mirrors porPromeshAttachment.middleware.js's structure, hardened per the
// Finance module's explicit security requirements:
//   - UUID-based stored filename (no timestamp/userId embedded — the real
//     original name is stored separately in FinanceDocument.originalName,
//     never used to build a filesystem path).
//   - Extension AND MIME type whitelist (existing upload middlewares in this
//     codebase only check the extension).
//   - originalName sanitized before it's ever persisted (strip path
//     separators/"../"/control chars) — none of the existing 5 upload
//     middlewares in this codebase do this; new hardening specific to
//     Finance, not a change to any existing module.
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "finance-documents");
// Taille maximale PAR FICHIER d'un document justificatif financier (bons de
// livraison, bons de commande, factures, paiements, imports) : 25 Mo.
// Surcharge possible par FINANCE_UPLOAD_MAX_FILE_MB. Le reverse proxy doit
// accepter le corps multipart COMPLET (plusieurs fichiers + en-têtes) : voir
// client_max_body_size côté Nginx.
const MAX_FILE_MB = Math.max(1, Number(process.env.FINANCE_UPLOAD_MAX_FILE_MB) || 25);

const ALLOWED_EXT = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".jpg", ".jpeg", ".png", ".webp", ".txt"]);

const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv", // certains navigateurs envoient ce type pour un .csv
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Empêche toute tentative de path traversal / caractères dangereux dans le
// nom d'origine avant qu'il ne soit persisté en base — jamais utilisé pour
// construire un chemin sur disque (le nom réel du fichier est
// `storedFileName`, généré ci-dessous), uniquement affiché à l'utilisateur.
function sanitizeOriginalName(name) {
  const base = String(name || "fichier")
    .replace(/[\\/]/g, "_") // séparateurs de chemin
    .replace(/\.\.+/g, ".") // "../", "..\\"
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "") // caractères de contrôle
    .trim();
  return (base || "fichier").slice(0, 255);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `finance-${crypto.randomUUID()}${ext}`);
  },
});

const financeDocumentUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error(`Type de fichier non autorisé. Formats acceptés : ${[...ALLOWED_EXT].join(", ")}`));
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error(`Type MIME non autorisé : ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// Erreurs d'upload du module Finance (à placer juste après le middleware
// multer). Un refus de multer n'atteint JAMAIS le contrôleur : aucune
// expédition / aucun bon n'est créé, aucune seconde erreur n'est produite, et
// multer a déjà retiré du disque les fichiers de la requête.
//   - fichier trop volumineux → HTTP 413 + message explicite ;
//   - trop de fichiers / champ inattendu / type refusé → HTTP 400.
// Journalisé de façon structurée (jamais de jeton ni de contenu).
function handleFinanceUploadError(err, req, res, next) {
  if (!err) return next();
  const logger = require("../utils/logger");
  let status = 400;
  let code = "FILE_UPLOAD_FAILED";
  let message = err.message || "Échec de l'envoi du fichier";
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      status = 413;
      code = "FILE_TOO_LARGE";
      message = `Le fichier dépasse la taille maximale autorisée de ${MAX_FILE_MB} Mo.`;
    } else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      message = "Trop de fichiers envoyés, ou champ de fichier inattendu.";
    } else {
      message = `Échec de l'envoi du fichier : ${err.message}`;
    }
  } else {
    code = "FILE_TYPE_NOT_ALLOWED";
  }
  logger.warn("[FINANCE UPLOAD] REJECTED", {
    step: "FILE_RECEIVED",
    code,
    httpStatus: status,
    multerCode: err.code || null,
    field: err.field || null,
    error: err.message,
    path: req.originalUrl ? req.originalUrl.split("?")[0] : null,
    userId: req.user?.sub || null,
  });
  return res.status(status).json({ success: false, code, step: "FILE_RECEIVED", message, ...(code === "FILE_TOO_LARGE" ? { maxFileMb: MAX_FILE_MB } : {}) });
}

module.exports = { financeDocumentUpload, handleFinanceUploadError, sanitizeOriginalName, UPLOAD_DIR, MAX_FILE_MB, ALLOWED_EXT };
