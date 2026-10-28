"use strict";

const Joi = require("joi");

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "all"];

const listQuerySchema = Joi.object({
  status: Joi.string().valid(...STATUSES),
  type: Joi.string().valid("promesh", "probar"),
  poste: Joi.string().valid("matin", "nuit"),
  machine: Joi.string().max(50),
  creator: Joi.string().email().max(255),
  search: Joi.string().allow("").max(100),
  // Période sur la date de production (YYYY-MM-DD, bornes incluses).
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  page: Joi.number().integer().min(1),
  pageSize: Joi.number().integer().min(1).max(500),
});

// Le motif obligatoire du refus est vérifié par le service
// (REJECTION_COMMENT_REQUIRED) : une chaîne vide passe ici.
const decisionSchema = Joi.object({
  version: Joi.number().integer().min(1),
  ficheUpdatedAt: Joi.date().iso(),
  comment: Joi.string().allow("").max(2000),
});

const resubmitSchema = Joi.object({
  comment: Joi.string().allow("").max(2000),
});

function validate(schema, source) {
  return function validator(req, res, next) {
    const { error, value } = schema.validate(req[source] || {}, { abortEarly: false, stripUnknown: true });
    if (error) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: error.details.map((d) => d.message.replace(/"/g, "")).join(" ; "),
      });
    }
    // Express 5 : req.query est en lecture seule — valeurs validées à part.
    if (source === "query") req.validatedQuery = value;
    else req[source] = value;
    return next();
  };
}

module.exports = {
  validateListQuery: validate(listQuerySchema, "query"),
  validateDecision: validate(decisionSchema, "body"),
  validateResubmit: validate(resubmitSchema, "body"),
};
