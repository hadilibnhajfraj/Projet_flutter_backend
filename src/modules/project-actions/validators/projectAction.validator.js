const Joi = require("joi");

const createSchema = Joi.object({
  actionTypeId: Joi.string().uuid().required().messages({
    "string.uuid": "actionTypeId must be a valid UUID",
    "any.required": "actionTypeId is required",
  }),
  commentaire: Joi.string().max(2000).allow(null, "").optional(),
  dateAction: Joi.date().iso().optional(),
  dateRelance: Joi.date().iso().greater("now").allow(null).optional().messages({
    "date.greater": "dateRelance must be a future date",
  }),
  reminderMessage: Joi.string().max(500).allow(null, "").optional(),
  statut: Joi.string().valid("A faire", "En cours", "Terminé").optional(),
  fileUrl: Joi.string().uri().allow(null, "").optional(),
});

const updateSchema = Joi.object({
  actionTypeId: Joi.string().uuid().optional(),
  commentaire: Joi.string().max(2000).allow(null, "").optional(),
  dateAction: Joi.date().iso().optional(),
  dateRelance: Joi.date().iso().allow(null).optional(),
  statut: Joi.string().valid("A faire", "En cours", "Terminé").optional(),
  fileUrl: Joi.string().uri().allow(null, "").optional(),
});

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({ errors: error.details.map((d) => d.message) });
    }
    req.body = value;
    next();
  };
}

module.exports = {
  validateCreate: validate(createSchema),
  validateUpdate: validate(updateSchema),
};
