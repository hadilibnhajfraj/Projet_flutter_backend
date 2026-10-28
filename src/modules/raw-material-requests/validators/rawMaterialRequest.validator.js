"use strict";

const Joi = require("joi");
const { MATERIALS, MODULES, STATUSES } = require("../../../config/rawMaterialRequest");

const CODES = MATERIALS.map((m) => m.code);

const quantity = (label) =>
  Joi.number()
    .min(0)
    .max(10000000)
    .required()
    .messages({
      "number.base": `"${label}" doit être un nombre valide`,
      "number.min": `"${label}" ne peut pas être négatif`,
      "number.max": `"${label}" est trop élevé`,
      "any.required": `"${label}" est obligatoire`,
    });

const itemSchema = Joi.object({
  material: Joi.string()
    .valid(...CODES)
    .required()
    .messages({ "any.only": `Matière inconnue (attendu : ${CODES.join(", ")})` }),
  reference: Joi.string().trim().max(100).allow(null, "").optional(),
  lot: Joi.string().trim().max(100).allow(null, "").optional(),
  quantiteDisponible: quantity("Quantité disponible"),
  besoinProduction: quantity("Besoin de production"),
  quantiteDemandee: quantity("Quantité demandée"),
});

const createSchema = Joi.object({
  clientRequestId: Joi.string().guid().required(),
  // Absent / null : demande faite à la connexion (aucun module choisi).
  module: Joi.string()
    .valid(...MODULES)
    .allow(null)
    .default(null),
  machine: Joi.string().max(50).allow(null, "").optional(),
  poste: Joi.string().valid("matin", "nuit").required(),
  // Les matières demandées (de 1 à 5), chacune une seule fois. Une matière
  // laissée vide dans le tableau n'est pas envoyée.
  items: Joi.array()
    .items(itemSchema)
    .min(1)
    .max(CODES.length)
    .unique("material")
    .required()
    .messages({
      "array.min": "La demande doit contenir au moins une matière",
      "array.max": `La demande ne peut pas contenir plus de ${CODES.length} matières`,
      "array.unique": "Chaque matière ne peut figurer qu'une seule fois",
    }),
});

// Filtres de la page de traçabilité (liste et export) : une valeur hors
// liste est refusée plutôt que transmise à la base.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const listQuerySchema = Joi.object({
  from: Joi.string().pattern(ISO_DATE).messages({ "string.pattern.base": "Date de début invalide (AAAA-MM-JJ)" }),
  to: Joi.string().pattern(ISO_DATE).messages({ "string.pattern.base": "Date de fin invalide (AAAA-MM-JJ)" }),
  userId: Joi.string().guid(),
  poste: Joi.string().valid("matin", "nuit"),
  material: Joi.string().valid(...CODES),
  status: Joi.string().valid(...Object.values(STATUSES)),
  module: Joi.string().valid(...MODULES),
  search: Joi.string().trim().max(50).allow(""),
  // Demandes à valider (en attente de validation ou soumises).
  toProcess: Joi.boolean(),
  page: Joi.number().integer().min(1),
  pageSize: Joi.number().integer().min(1).max(200),
});

// Correction d'une demande rejetée : mêmes règles de lignes que la création.
const resubmitSchema = Joi.object({
  clientRequestId: Joi.string().guid().optional(),
  items: createSchema.extract("items"),
});

const statusSchema = Joi.object({
  status: Joi.string()
    .valid(...Object.values(STATUSES))
    .required()
    .messages({ "any.only": "Statut inconnu", "any.required": "Le nouveau statut est obligatoire" }),
  comment: Joi.string().trim().max(1000).allow(null, "").optional(),
  // Statut affiché lors de la décision : si la demande a changé entre-temps
  // (autre responsable), la décision est refusée au lieu d'écraser l'autre.
  expectedStatus: Joi.string().valid(...Object.values(STATUSES)).optional(),
});

// Shift soir : une quantité réelle (≥ 0) par matière ; motif de refus obligatoire.
const eveningAcceptSchema = Joi.object({
  actualItems: Joi.array()
    .items(
      Joi.object({
        material: Joi.string()
          .valid(...CODES)
          .required()
          .messages({ "any.only": `Matière inconnue (attendu : ${CODES.join(", ")})` }),
        quantiteReelle: Joi.number()
          .min(0)
          .max(10000000)
          .required()
          .messages({
            "number.base": `"Quantité réelle" doit être un nombre valide`,
            "number.min": `"Quantité réelle" ne peut pas être négative`,
            "number.max": `"Quantité réelle" est trop élevée`,
            "any.required": `"Quantité réelle" est obligatoire`,
          }),
      })
    )
    .min(1)
    .unique("material")
    .required()
    .messages({
      "array.min": "Les quantités réelles sont obligatoires",
      "array.unique": "Chaque matière ne peut figurer qu'une seule fois",
      "any.required": "Les quantités réelles sont obligatoires",
    }),
});

const eveningRefuseSchema = Joi.object({
  comment: Joi.string()
    .trim()
    .min(1)
    .max(1000)
    .required()
    .messages({ "any.required": "Le motif du refus est obligatoire", "string.empty": "Le motif du refus est obligatoire" }),
});

function respond400(res, error) {
  return res.status(400).json({
    success: false,
    code: "VALIDATION_ERROR",
    message: error.details.map((d) => d.message.replace(/"/g, "")).join(" ; "),
    errors: error.details.map((d) => ({ field: d.path.join("."), message: d.message })),
  });
}

function validate(schema, source) {
  return function validator(req, res, next) {
    const { error, value } = schema.validate(req[source], { abortEarly: false, stripUnknown: true });
    if (error) return respond400(res, error);
    // Express 5 : req.query est en lecture seule — valeurs validées à part.
    if (source === "query") req.validatedQuery = value;
    else req[source] = value;
    return next();
  };
}

module.exports = {
  validateCreate: validate(createSchema, "body"),
  validateListQuery: validate(listQuerySchema, "query"),
  validateStatusChange: validate(statusSchema, "body"),
  validateResubmit: validate(resubmitSchema, "body"),
  validateEveningAccept: validate(eveningAcceptSchema, "body"),
  validateEveningRefuse: validate(eveningRefuseSchema, "body"),
};
