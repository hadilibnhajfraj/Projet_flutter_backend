const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Mirrors actionUpload.middleware.js — files land in uploads/porpromesh/ so
// express.static("uploads") serves them at /uploads/porpromesh/<file>.
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "porpromesh");
const MAX_FILE_MB = 10;
const ALLOWED_EXT = new Set([".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".xls", ".xlsx"]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const userId = req.user?.sub || req.user?.id || "anon";
    cb(null, `porpromesh-${userId}-${Date.now()}${ext}`);
  },
});

const attachmentUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error(`File type not allowed. Accepted: ${[...ALLOWED_EXT].join(", ")}`));
  },
});

module.exports = { attachmentUpload };
