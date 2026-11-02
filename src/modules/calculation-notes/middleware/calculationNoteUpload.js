"use strict";

const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { sanitizeOriginalName } = require("../../../middleware/financeDocumentUpload.middleware");

// Upload des documents de notes de calcul (PDF, DOC, DOCX, XLS, XLSX).
//
// Différences volontaires avec les autres uploads du CRM :
//   - stockage PRIVÉ, hors du dossier `uploads/` servi publiquement par
//     express.static : un fichier n'est lisible que par la route de
//     téléchargement, qui revérifie les permissions ;
//   - vérification RÉELLE du contenu (signature binaire), pas seulement de
//     l'extension ou du type MIME annoncé par le navigateur ;
//   - documents Office avec macros (vbaProject.bin) refusés ;
//   - nom de fichier sur disque généré par le serveur (UUID), jamais dérivé
//     du nom d'origine (aucun chemin arbitraire possible).
const STORAGE_DIR = path.resolve(process.env.CALCULATION_NOTES_STORAGE_DIR || path.join(process.cwd(), "storage", "calculation-notes"));
const MAX_FILE_MB = Math.max(1, Number(process.env.CALCULATION_NOTE_MAX_FILE_MB) || 20);
const MAX_FILES = 10;

const TYPES = {
  ".pdf": { mime: "application/pdf", kind: "pdf" },
  ".doc": { mime: "application/msword", kind: "ole" },
  ".xls": { mime: "application/vnd.ms-excel", kind: "ole" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "ooxml", part: "word/" },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "ooxml", part: "xl/" },
};
const ALLOWED_EXTENSIONS = Object.keys(TYPES);

const PDF_MAGIC = Buffer.from("%PDF-");
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

class UploadRejected extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Contrôle le contenu réel du fichier par rapport à son extension.
// Retourne { extension, mimeType } ou lève UploadRejected.
function inspectFile(originalName, buffer) {
  const extension = path.extname(String(originalName || "")).toLowerCase();
  const type = TYPES[extension];
  if (!type) {
    throw new UploadRejected("FILE_TYPE_NOT_ALLOWED", `Format non autorisé. Formats acceptés : PDF, DOC, DOCX, XLS, XLSX.`);
  }
  if (!buffer || buffer.length === 0) throw new UploadRejected("FILE_EMPTY", "Le fichier est vide.");

  let ok = false;
  if (type.kind === "pdf") {
    // %PDF- dans les 1024 premiers octets (tolérance de la spécification).
    ok = buffer.subarray(0, 1024).indexOf(PDF_MAGIC) !== -1;
  } else if (type.kind === "ole") {
    ok = buffer.subarray(0, 8).equals(OLE_MAGIC);
  } else if (type.kind === "ooxml") {
    // Archive ZIP dont les entrées (noms en clair) contiennent la partie
    // attendue (word/ ou xl/) et [Content_Types].xml.
    ok = buffer.subarray(0, 4).equals(ZIP_MAGIC) && buffer.includes(Buffer.from("[Content_Types].xml")) && buffer.includes(Buffer.from(type.part));
    if (ok && buffer.includes(Buffer.from("vbaProject.bin"))) {
      throw new UploadRejected("FILE_MACRO_NOT_ALLOWED", "Les documents contenant des macros ne sont pas acceptés.");
    }
  }
  if (!ok) {
    throw new UploadRejected("FILE_CONTENT_MISMATCH", `Le contenu du fichier ne correspond pas à un fichier ${extension.slice(1).toUpperCase()} valide.`);
  }
  return { extension, mimeType: type.mime };
}

// Écrit le fichier sous un nom généré par le serveur. Retourne les
// métadonnées à persister. `wx` : n'écrase jamais un fichier existant.
async function storeFile(file) {
  const originalName = sanitizeOriginalName(file.originalname);
  const { extension, mimeType } = inspectFile(originalName, file.buffer);
  await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
  const storedFileName = `nc-${crypto.randomUUID()}${extension}`;
  await fs.promises.writeFile(path.join(STORAGE_DIR, storedFileName), file.buffer, { flag: "wx", mode: 0o640 });
  return {
    originalName,
    storedFileName,
    extension: extension.slice(1),
    mimeType,
    sizeBytes: file.buffer.length,
    sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
  };
}

// Chemin absolu d'un fichier stocké, ou null si le nom n'a pas la forme
// générée par le serveur (aucun chemin arbitraire, aucune sortie du dossier).
function resolveStoredPath(storedFileName) {
  if (!/^nc-[0-9a-f-]{36}\.(pdf|docx?|xlsx?)$/.test(String(storedFileName || ""))) return null;
  const full = path.resolve(STORAGE_DIR, storedFileName);
  return path.dirname(full) === STORAGE_DIR ? full : null;
}

async function removeStoredFiles(names) {
  await Promise.all(
    names.map((n) => {
      const p = resolveStoredPath(n);
      return p ? fs.promises.unlink(p).catch(() => {}) : null;
    })
  );
}

// En mémoire (limite configurable) : le contenu est inspecté AVANT toute
// écriture sur disque.
const calculationNoteUpload = multer({
  storage: multer.memoryStorage(),
  // Noms accentués (« Note de calcul é.pdf ») conservés tels quels.
  defParamCharset: "utf8",
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES, fields: 30, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!TYPES[ext]) return cb(new UploadRejected("FILE_TYPE_NOT_ALLOWED", "Format non autorisé. Formats acceptés : PDF, DOC, DOCX, XLS, XLSX."));
    return cb(null, true);
  },
}).array("files", MAX_FILES);

function handleCalculationNoteUpload(req, res, next) {
  calculationNoteUpload(req, res, (err) => {
    if (!err) return next();
    let status = 400;
    let code = err.code || "FILE_UPLOAD_FAILED";
    let message = err.message || "Échec de l'envoi du fichier.";
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        status = 413;
        code = "FILE_TOO_LARGE";
        message = `Le fichier dépasse la taille maximale autorisée de ${MAX_FILE_MB} Mo.`;
      } else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        code = "TOO_MANY_FILES";
        message = `Au maximum ${MAX_FILES} fichiers par envoi (champ « files »).`;
      }
    }
    return res.status(status).json({ success: false, code, message, ...(status === 413 ? { maxFileMb: MAX_FILE_MB } : {}) });
  });
}

module.exports = {
  STORAGE_DIR,
  MAX_FILE_MB,
  MAX_FILES,
  ALLOWED_EXTENSIONS,
  UploadRejected,
  inspectFile,
  storeFile,
  resolveStoredPath,
  removeStoredFiles,
  handleCalculationNoteUpload,
};
