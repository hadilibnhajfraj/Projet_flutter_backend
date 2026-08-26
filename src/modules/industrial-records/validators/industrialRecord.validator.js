"use strict";

const Joi = require("joi");

// §MODIFICATION — FICHE MÉLANGE : dropdown "PROMESH" — valeurs EXACTES
// imposées par le ticket, jamais une valeur inventée/normalisée.
const MELANGE_PROMESH_VALUES = ["PROMESH #1", "PROMESH #2", "PROMESH #3", "PROMESH #4"];
// Format HH:mm (24h) — même convention que le TimePicker Flutter (voir
// melange_form_screen.dart). La comparaison heureFin >= heureDebut (voir le
// .custom() plus bas) est une comparaison de chaînes, valable uniquement
// sous ce format zero-paddé.
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

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

  // §MODIFICATION — FICHE MÉLANGE : heureDebut/heureFin/quantiteProduite/
  // promesh deviennent OBLIGATOIRES uniquement quand module === 'melange'
  // (voir .when() ci-dessous) — n'affecte jamais PROBAR/MAINTENANCE, qui
  // laissent ces champs vides comme avant.
  heureDebut: Joi.string()
    .pattern(TIME_PATTERN)
    .messages({ "string.pattern.base": `"heureDebut" doit être au format HH:mm` })
    .when("module", {
      is: "melange",
      then: Joi.required().messages({ "any.required": `"heureDebut" est obligatoire pour la Fiche MÉLANGE` }),
      otherwise: Joi.allow(null, "").optional(),
    }),
  heureFin: Joi.string()
    .pattern(TIME_PATTERN)
    .messages({ "string.pattern.base": `"heureFin" doit être au format HH:mm` })
    .when("module", {
      is: "melange",
      then: Joi.required().messages({ "any.required": `"heureFin" est obligatoire pour la Fiche MÉLANGE` }),
      otherwise: Joi.allow(null, "").optional(),
    }),
  promesh: Joi.string()
    .valid(...MELANGE_PROMESH_VALUES)
    .when("module", {
      is: "melange",
      then: Joi.required().messages({ "any.required": `"promesh" est obligatoire pour la Fiche MÉLANGE` }),
      otherwise: Joi.allow(null, "").optional(),
    }),
  // §MODIFICATION — FICHE MÉLANGE (simplification) : renommé depuis
  // "echantillon" — texte libre, toujours optionnel.
  dechet: Joi.string().max(255).allow(null, "").optional(),

  // melangeData : JSON complet du formulaire MÉLANGE (ravitaillement, consommation, rapport…)
  // Les autres modules envoient null — ce champ est ignoré.
  melangeData: Joi.object().allow(null).optional(),

  statut: Joi.string().max(50).allow(null, "").optional(),
};

// quantiteProduite est déjà présent dans baseFields pour PROBAR/MAINTENANCE
// (min(0), optionnel) — surchargé ici pour MÉLANGE : obligatoire et > 0.
const quantiteProduiteField = baseFields.quantiteProduite.when("module", {
  is: "melange",
  then: Joi.number()
    .greater(0)
    .required()
    .messages({
      "any.required": `"quantiteProduite" est obligatoire pour la Fiche MÉLANGE`,
      "number.greater": `"quantiteProduite" doit être supérieure à 0`,
    }),
});

const meleangeAwareFields = { ...baseFields, quantiteProduite: quantiteProduiteField };

// §MODIFICATION — FICHE MÉLANGE : heureFin >= heureDebut, validé sur les
// DEUX champs ensemble (impossible via une règle Joi par-champ isolée) —
// n'intervient que si le module de la fiche est 'melange' ET que les deux
// heures sont renseignées (le caractère obligatoire lui-même est déjà porté
// par le .when() ci-dessus, pas par ce .custom()).
function validateMelangeTimes(value, helpers) {
  if (value.module === "melange" && value.heureDebut && value.heureFin && value.heureFin < value.heureDebut) {
    return helpers.message('"heureFin" doit être postérieure ou égale à "heureDebut"');
  }
  return value;
}

const createSchema = Joi.object({
  ...meleangeAwareFields,
  module: baseFields.module.required(),
  dateFiche: baseFields.dateFiche.required(),
}).custom(validateMelangeTimes);

// Update : même schéma MÉLANGE-aware (le formulaire Flutter envoie toujours
// module + l'objet complet — voir melange_form_screen.dart._save()) — donc
// heureDebut/heureFin/quantiteProduite/promesh restent bien obligatoires
// pour une fiche MÉLANGE, y compris en édition.
const updateSchema = Joi.object(meleangeAwareFields).min(1).custom(validateMelangeTimes);

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
