const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Mirrors porPromeshAttachment.middleware.js — files land in
// uploads/maintenance-requests/ so express.static("uploads") serves them at
// /uploads/maintenance-requests/<file>.
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "maintenance-requests");
const MAX_FILE_MB = 10;
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png"]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const userId = req.user?.sub || req.user?.id || "anon";
    cb(null, `maintenance-${userId}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const maintenanceRequestUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error(`Type de fichier non autorisé. Acceptés : ${[...ALLOWED_EXT].join(", ")}`));
  },
});

module.exports = { maintenanceRequestUpload };
