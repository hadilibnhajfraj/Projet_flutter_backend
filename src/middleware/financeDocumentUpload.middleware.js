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
const MAX_FILE_MB = 10;

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

module.exports = { financeDocumentUpload, sanitizeOriginalName, UPLOAD_DIR, MAX_FILE_MB, ALLOWED_EXT };
