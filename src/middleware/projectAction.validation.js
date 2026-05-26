const multer = require("multer");

const VALID_STATUTS = ["A faire", "En cours", "Terminé", "Annulé"];
const DEFAULT_ACTION_TYPE = "Visite";

exports.validateCreateAction = (req, res, next) => {
  // ── Debug — log full parsed body and file after Multer runs ──────────
  console.log("BODY =", req.body);
  console.log("FILE =", req.file);

  const errors = [];

  // ── Resolve action type with safe fallback (all three field names) ───
  const actionType =
    (req.body.typeAction || "").trim() ||
    (req.body.typeAction_legacy || "").trim() ||
    (req.body.firstAction || "").trim() ||
    DEFAULT_ACTION_TYPE;

  console.log("ACTION TYPE =", actionType);

  if (actionType.length > 100) {
    errors.push("Action type must not exceed 100 characters.");
  }

  // ── statut (optional — defaults to 'A faire') ────────────────────────
  if (req.body.statut && !VALID_STATUTS.includes(req.body.statut)) {
    errors.push(
      `Invalid statut. Must be one of: ${VALID_STATUTS.join(", ")}.`
    );
  }

  // ── dateAction (optional — defaults to NOW) ──────────────────────────
  if (req.body.dateAction && isNaN(Date.parse(req.body.dateAction))) {
    errors.push("dateAction must be a valid ISO date string.");
  }

  // ── dateRelance (optional) ────────────────────────────────────────────
  if (req.body.dateRelance && isNaN(Date.parse(req.body.dateRelance))) {
    errors.push("dateRelance must be a valid ISO date string.");
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors,
    });
  }

  // Pass resolved type to controller via req so it always has a value
  req.resolvedActionType = actionType;
  next();
};

// ── Multer upload error handler (wire as 5th arg after validateCreateAction) ──
exports.handleUploadError = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: `File upload error: ${err.message}`,
    });
  }
  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message || "Upload failed",
    });
  }
  next();
};
