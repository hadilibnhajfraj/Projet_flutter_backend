const Joi = require("joi");

const HEX_COLOR = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

const createSchema = Joi.object({
  name: Joi.string().max(120).required().messages({
    "string.max": "name must be ≤ 120 characters",
    "any.required": "name is required",
  }),
  color: Joi.string().pattern(HEX_COLOR).optional().messages({
    "string.pattern.base": "color must be a valid hex (e.g. #3b82f6)",
  }),
  icon: Joi.string().max(50).optional(),
  position: Joi.number().integer().min(0).optional(),
  isDefault: Joi.boolean().optional(),
  isWonStage: Joi.boolean().optional(),
  isLostStage: Joi.boolean().optional(),
  autoCreateAction: Joi.boolean().optional(),
  isCustom: Joi.boolean().optional(),
});

const updateSchema = Joi.object({
  name: Joi.string().max(120).optional(),
  color: Joi.string().pattern(HEX_COLOR).optional().messages({
    "string.pattern.base": "color must be a valid hex (e.g. #3b82f6)",
  }),
  icon: Joi.string().max(50).allow(null).optional(),
  position: Joi.number().integer().min(0).optional(),
  isDefault: Joi.boolean().optional(),
  isWonStage: Joi.boolean().optional(),
  isLostStage: Joi.boolean().optional(),
  autoCreateAction: Joi.boolean().optional(),
  isCustom: Joi.boolean().optional(),
});

const reorderSchema = Joi.object({
  stages: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().uuid().required(),
        position: Joi.number().integer().min(0).required(),
      })
    )
    .min(1)
    .required(),
});

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
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
  validateReorder: validate(reorderSchema),
};
