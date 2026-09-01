"use strict";

const Joi = require("joi");

// 12 diamètres fixes — jamais de valeur libre ("Autre" supprimé).
const DIAMETRES = ["6", "8", "10", "12", "14", "16", "18", "20", "22", "24", "26", "28"];

// Une seule requête : en-tête de fiche + tableau des 12 lignes (une par
// diamètre). Aucune valeur numérique n'est obligatoire — un champ vide
// vaut 0 (Joi.default(0)).
const recuperableItemSchema = Joi.object({
  diametre: Joi.string().valid(...DIAMETRES).required().messages({
    "any.only": `Le diamètre doit être l'une des valeurs suivantes : ${DIAMETRES.join(", ")}.`,
    "any.required": "Le diamètre est obligatoire.",
  }),
  dechetKg: Joi.number().min(0).default(0).messages({
    "number.base": "Le déchet (kg) doit être un nombre.",
    "number.min": "Le déchet (kg) ne peut pas être négatif.",
  }),
  dechetProduitFiniKg: Joi.number().min(0).default(0).messages({
    "number.base": "Le déchet + produit fini (kg) doit être un nombre.",
    "number.min": "Le déchet + produit fini (kg) ne peut pas être négatif.",
  }),
});

const saveFicheSchema = Joi.object({
  module: Joi.string().valid("PROBAR", "PROMESH").required().messages({
    "any.only": "Le module doit être PROBAR ou PROMESH.",
    "any.required": "Le module est obligatoire.",
  }),
  machine: Joi.string().valid("1", "2", "3", "4").required().messages({
    "any.only": "La machine doit être 1, 2, 3 ou 4.",
    "any.required": "La machine est obligatoire.",
  }),
  ligne: Joi.string().valid("L1", "L2", "L3", "L4").required().messages({
    "any.only": "La ligne doit être L1, L2, L3 ou L4.",
    "any.required": "La ligne est obligatoire.",
  }),
  poste: Joi.string().valid("matin", "soir").required().messages({
    "any.only": "Le poste doit être matin ou soir.",
    "any.required": "Le poste est obligatoire.",
  }),
  date: Joi.date().iso().required().messages({
    "date.base": "La date doit être une date valide.",
    "date.format": "La date doit être au format ISO (AAAA-MM-JJ).",
    "any.required": "La date est obligatoire.",
  }),
  // Envoyé par le client pour affichage immédiat, mais toujours recalculé
  // côté serveur depuis le profil de l'utilisateur connecté — jamais fait
  // confiance à cette valeur pour l'enregistrement définitif.
  operateur: Joi.string().max(255).allow(null, "").optional(),
  // §MODIFICATION — FICHE RECOVERABLES PROCESSED SIMPLIFIÉE : remplace le
  // tableau par diamètre par deux valeurs directes (noms EXACTS demandés
  // par le ticket). `recuperables` reste accepté pour compatibilité
  // ascendante (jamais envoyé par le nouveau formulaire, voir
  // recuperable.service.js#saveFiche) — aucune ancienne donnée affectée.
  waste: Joi.number().min(0).default(0).messages({
    "number.base": "Waste (kg) doit être un nombre.",
    "number.min": "Waste (kg) ne peut pas être négatif.",
  }),
  // Champ hérité (formulaire combiné retiré depuis) — accepté pour
  // compatibilité ascendante uniquement, plus jamais envoyé par le
  // formulaire actuel (voir `finishedProduct` ci-dessous, la valeur
  // INDÉPENDANTE désormais utilisée).
  wasteFinishedProduct: Joi.number().min(0).default(0).messages({
    "number.base": "Waste + Finished Product (kg) doit être un nombre.",
    "number.min": "Waste + Finished Product (kg) ne peut pas être négatif.",
  }),
  finishedProduct: Joi.number().min(0).default(0).messages({
    "number.base": "Finished Product (kg) doit être un nombre.",
    "number.min": "Finished Product (kg) ne peut pas être négatif.",
  }),
  recuperables: Joi.array().items(recuperableItemSchema).default([]),
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
  DIAMETRES,
  validateSaveFiche: validate(saveFicheSchema),
};
