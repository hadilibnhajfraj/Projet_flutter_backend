const Joi = require("joi");

const moveStageSchema = Joi.object({
  pipelineStageId: Joi.string().uuid().required().messages({
    "string.uuid": "pipelineStageId must be a valid UUID",
    "any.required": "pipelineStageId is required",
  }),
});

const assignOwnerSchema = Joi.object({
  ownerId: Joi.string().uuid().allow(null).required().messages({
    "string.uuid": "ownerId must be a valid UUID",
    "any.required": "ownerId is required",
  }),
});

const listQuerySchema = Joi.object({
  mine: Joi.string().valid("true", "false").optional(),
  // Flutter sends ?myProjects=true — treated identically to mine=true
  myProjects: Joi.string().valid("true", "false").optional(),
  stageId: Joi.string().uuid().optional(),
  projectModele: Joi.string().valid("project", "revendeur", "applicateur").optional(),
  search: Joi.string().max(200).allow("").optional(),
  isArchived: Joi.string().valid("true", "false").optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  sortBy: Joi.string().valid("createdAt", "nomProjet", "montantMarche", "pourcentageReussite").optional(),
  sortDir: Joi.string().valid("ASC", "DESC").optional(),
  ownerId: Joi.string().uuid().optional(),
  userId: Joi.string().uuid().optional(),
  dateFrom: Joi.date().iso().optional(),
  dateTo: Joi.date().iso().optional(),
});

function validate(schema, source = "body") {
  return (req, res, next) => {
    const target = source === "query" ? req.query : req.body;
    const { error, value } = schema.validate(target, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({ errors: error.details.map((d) => d.message) });
    }
    if (source === "query") req.query = value;
    else req.body = value;
    next();
  };
}

module.exports = {
  validateMoveStage: validate(moveStageSchema),
  validateAssignOwner: validate(assignOwnerSchema),
  validateListQuery: validate(listQuerySchema, "query"),
};
