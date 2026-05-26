const Joi = require("joi");

// ── Create ────────────────────────────────────────────────────────────────────
// Accepts both the new FK system (actionTypeId) and every legacy field name
// Flutter may send (typeAction / typeAction_legacy / firstAction).
// At least one action-type field must be present; the service resolves priority.
const createSchema = Joi.object({
  // New dynamic system (UUID FK)
  actionTypeId: Joi.string().uuid().optional().messages({
    "string.uuid": "actionTypeId must be a valid UUID",
  }),

  // Legacy / Flutter field names — all accepted for backward compatibility
  typeAction: Joi.string().max(100).allow(null, "").optional(),
  typeAction_legacy: Joi.string().max(100).allow(null, "").optional(),
  firstAction: Joi.string().max(100).allow(null, "").optional(),

  commentaire: Joi.string().max(2000).allow(null, "").optional(),
  dateAction: Joi.date().iso().optional(),
  dateRelance: Joi.date().iso().allow(null).optional().custom((value, helpers) => {
    if (!value) return value;
    // Allow up to 60 s in the past to absorb network latency and client clock
    // skew when the user selects "today" or the current hour.
    const tolerance = new Date();
    tolerance.setMinutes(tolerance.getMinutes() - 1);
    console.log("dateRelance =", value, "| threshold =", tolerance);
    if (value < tolerance) {
      return helpers.error("date.tooOld");
    }
    return value;
  }).messages({
    "date.tooOld": "dateRelance must be today or a future date",
  }),
  reminderMessage: Joi.string().max(500).allow(null, "").optional(),
  statut: Joi.string().valid("A faire", "En cours", "Terminé", "Annulé").optional(),
  fileUrl: Joi.string().uri().allow(null, "").optional(),
})
  // Require at least one action-type field to be present
  .or("actionTypeId", "typeAction", "typeAction_legacy", "firstAction")
  .messages({
    "object.missing":
      "Action type is required. Provide actionTypeId, typeAction, typeAction_legacy, or firstAction.",
  });

// ── Update ────────────────────────────────────────────────────────────────────
const updateSchema = Joi.object({
  actionTypeId: Joi.string().uuid().optional().messages({
    "string.uuid": "actionTypeId must be a valid UUID",
  }),
  typeAction: Joi.string().max(100).allow(null, "").optional(),
  typeAction_legacy: Joi.string().max(100).allow(null, "").optional(),
  commentaire: Joi.string().max(2000).allow(null, "").optional(),
  dateAction: Joi.date().iso().optional(),
  dateRelance: Joi.date().iso().allow(null).optional(),
  statut: Joi.string().valid("A faire", "En cours", "Terminé", "Annulé").optional(),
  fileUrl: Joi.string().uri().allow(null, "").optional(),
});

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: false, // preserve legacy fields so the service can read them
    });
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.details.map((d) => d.message),
      });
    }
    req.body = value;
    next();
  };
}

module.exports = {
  validateCreate: validate(createSchema),
  validateUpdate: validate(updateSchema),
};
