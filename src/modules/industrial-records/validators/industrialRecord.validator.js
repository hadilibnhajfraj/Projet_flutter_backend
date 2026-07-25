"use strict";

const Joi = require("joi");

const baseFields = {
  module: Joi.string().valid("probar", "melange", "maintenance"),
  machine: Joi.string().max(50).allow(null, "").optional(),
  poste: Joi.string().valid("matin", "nuit").allow(null, "").empty("").optional(),
  dateFiche: Joi.date().iso(),
  operateur: Joi.string().max(255).allow(null, "").optional(),

  quantiteProduite: Joi.number().min(0).allow(null).empty("").optional(),
  statutQualite: Joi.string().valid("ok", "nok").allow(null, "").empty("").optional(),

  typePanne: Joi.string().max(255).allow(null, "").optional(),
  urgence: Joi.string().valid("faible", "moyenne", "critique").allow(null, "").empty("").optional(),
  // description : plus de limite de taille (TEXT PostgreSQL, pas de max côté validation)
  description: Joi.string().allow(null, "").optional(),
  observations: Joi.string().allow(null, "").optional(),

  // melangeData : JSON complet du formulaire MÉLANGE (ravitaillement, consommation, rapport…)
  // Les autres modules envoient null — ce champ est ignoré.
  melangeData: Joi.object().allow(null).optional(),

  statut: Joi.string().max(50).allow(null, "").optional(),
};

const createSchema = Joi.object({
  ...baseFields,
  module: baseFields.module.required(),
  dateFiche: baseFields.dateFiche.required(),
});

const updateSchema = Joi.object(baseFields).min(1);

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
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
