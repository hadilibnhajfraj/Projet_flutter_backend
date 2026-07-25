"use strict";

const Joi = require("joi");

// Téléphone : chiffres, espaces, +, -, ( ) — assez permissif pour couvrir les
// formats locaux et internationaux sans rejeter des numéros valides.
const PHONE_PATTERN = /^[0-9+\-() .]{6,20}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:mm

// ── Règle générale ────────────────────────────────────────────────────────
// Chaque champ conditionnel utilise `Joi.when('type', { is, then, otherwise })`
// où `then`/`otherwise` sont TOUJOURS des schémas complets et typés
// (Joi.date(), Joi.string(), ...) — jamais un fragment nu comme
// `Joi.required()` seul, qui retourne un schéma `any()` sans `.min()`/
// `.pattern()`. C'est exactement ce qui causait le crash précédent
// (`Joi.required(...).min is not a function`).

const createSchema = Joi.object({
  type: Joi.string().valid("conge", "sortie").required().messages({
    "any.only": "Le type de demande doit être 'conge' ou 'sortie'.",
    "any.required": "Le type de demande est obligatoire.",
  }),

  // ── Informations employé (optionnelles) ─────────────────────────────────
  // Le profil RH (UserProfile) est la source prioritaire — ces champs ne
  // servent que de repli quand le profil ne les contient pas encore
  // (l'utilisateur les a alors saisis lui-même dans le formulaire).
  employeeNom: Joi.string().max(120).allow(null, "").optional(),
  employeePrenom: Joi.string().max(120).allow(null, "").optional(),
  employeeMatricule: Joi.string().max(50).allow(null, "").optional(),
  employeeQualification: Joi.string().max(150).allow(null, "").optional(),
  employeeDepartement: Joi.string().max(150).allow(null, "").optional(),
  employeeService: Joi.string().max(150).allow(null, "").optional(),

  // ── Demande de congé ────────────────────────────────────────────────────
  typeConge: Joi.when("type", {
    is: "conge",
    then: Joi.string().valid("ordinaire", "maladie").required().messages({
      "any.only": "Le type de congé doit être 'ordinaire' ou 'maladie'.",
      "any.required": "Le type de congé est obligatoire.",
    }),
    otherwise: Joi.forbidden(),
  }),

  dateDebut: Joi.when("type", {
    is: "conge",
    then: Joi.date().iso().required().messages({
      "date.base": "La date de début doit être une date valide.",
      "date.format": "La date de début doit être au format ISO (AAAA-MM-JJ).",
      "any.required": "La date de début est obligatoire.",
    }),
    otherwise: Joi.forbidden(),
  }),

  // dateFin référence dateDebut via Joi.ref — min() n'est disponible que sur
  // un schéma Joi.date(), jamais sur le résultat nu de Joi.required().
  dateFin: Joi.when("type", {
    is: "conge",
    then: Joi.date().iso().required().min(Joi.ref("dateDebut")).messages({
      "date.base": "La date de fin doit être une date valide.",
      "date.format": "La date de fin doit être au format ISO (AAAA-MM-JJ).",
      "date.min": "La date de fin doit être supérieure ou égale à la date de début.",
      "any.required": "La date de fin est obligatoire.",
    }),
    otherwise: Joi.forbidden(),
  }),

  adresse: Joi.when("type", {
    is: "conge",
    then: Joi.string().max(255).required().messages({
      "string.max": "L'adresse ne doit pas dépasser 255 caractères.",
      "any.required": "L'adresse pendant le congé est obligatoire.",
      "string.empty": "L'adresse pendant le congé est obligatoire.",
    }),
    otherwise: Joi.forbidden(),
  }),

  telephone: Joi.when("type", {
    is: "conge",
    then: Joi.string().pattern(PHONE_PATTERN).required().messages({
      "string.pattern.base": "Numéro de téléphone invalide.",
      "any.required": "Le téléphone est obligatoire.",
      "string.empty": "Le téléphone est obligatoire.",
    }),
    otherwise: Joi.string().pattern(PHONE_PATTERN).allow(null, "").optional().messages({
      "string.pattern.base": "Numéro de téléphone invalide.",
    }),
  }),

  // ── Autorisation de sortie ──────────────────────────────────────────────
  motif: Joi.when("type", {
    is: "sortie",
    then: Joi.string().max(255).required().messages({
      "string.max": "Le motif ne doit pas dépasser 255 caractères.",
      "any.required": "Le motif est obligatoire.",
      "string.empty": "Le motif est obligatoire.",
    }),
    otherwise: Joi.forbidden(),
  }),

  dateSortie: Joi.when("type", {
    is: "sortie",
    then: Joi.date().iso().required().messages({
      "date.base": "La date de sortie doit être une date valide.",
      "date.format": "La date de sortie doit être au format ISO (AAAA-MM-JJ).",
      "any.required": "La date de sortie est obligatoire.",
    }),
    otherwise: Joi.forbidden(),
  }),

  heureSortie: Joi.when("type", {
    is: "sortie",
    then: Joi.string().pattern(TIME_PATTERN).required().messages({
      "string.pattern.base": "Heure de sortie invalide (format HH:mm).",
      "any.required": "L'heure de sortie est obligatoire.",
      "string.empty": "L'heure de sortie est obligatoire.",
    }),
    otherwise: Joi.forbidden(),
  }),

  heureRetour: Joi.when("type", {
    is: "sortie",
    then: Joi.string().pattern(TIME_PATTERN).required().messages({
      "string.pattern.base": "Heure de retour invalide (format HH:mm).",
      "any.required": "L'heure de retour est obligatoire.",
      "string.empty": "L'heure de retour est obligatoire.",
    }),
    otherwise: Joi.forbidden(),
  }),

  commentaire: Joi.string().max(2000).allow(null, "").optional().messages({
    "string.max": "Le commentaire ne doit pas dépasser 2000 caractères.",
  }),
})
  // Heure retour > heure sortie (comparaison lexicographique valide car
  // format HH:mm à largeur fixe, déjà validé par TIME_PATTERN ci-dessus).
  .custom((value, helpers) => {
    if (value.type === "sortie" && value.heureSortie && value.heureRetour) {
      if (value.heureRetour <= value.heureSortie) {
        return helpers.error("hrRequest.heureRetour");
      }
    }
    return value;
  }, "heureRetour > heureSortie")
  .messages({
    "hrRequest.heureRetour": "L'heure de retour doit être postérieure à l'heure de sortie.",
  });

const updateStatusSchema = Joi.object({
  statut: Joi.string().valid("en_attente", "acceptee", "refusee").required().messages({
    "any.only": "Le statut doit être 'en_attente', 'acceptee' ou 'refusee'.",
    "any.required": "Le statut est obligatoire.",
  }),
});

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
  validateUpdateStatus: validate(updateStatusSchema),
};
