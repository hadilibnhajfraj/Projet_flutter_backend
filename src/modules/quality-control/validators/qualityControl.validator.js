"use strict";

const Joi = require("joi");
const cfg = require("../../../config/qualityControl");

// Contrôles d'un prélèvement / paramètres physiques de la fiche : deux niveaux
// distincts, jamais mélangés.
const PARAMETER_KEYS = cfg.readingParameters.map((p) => p.key);
const PHYSICAL_KEYS = cfg.parameters.filter((p) => p.scope === "fiche").map((p) => p.key);

// Utilisateur, machine et fiche ne sont JAMAIS acceptés du client (posés par
// le serveur — `stripUnknown` les retire, y compris tout productionRecordId :
// l'association à la production est recalculée par le serveur). Champs
// d'en-tête modifiables par le contrôleur (PUT / POST validate) : date et
// heure d'ouverture (controlDate / controlTime), date de production, poste,
// lot, ordre de fabrication.
const itemSchema = Joi.object({
  parameterKey: Joi.string().valid(...PARAMETER_KEYS).required().messages({
    "any.only": "Paramètre de contrôle inconnu.",
    "any.required": "Le paramètre est obligatoire.",
  }),
  value: Joi.string().allow("", null).max(255).messages({
    "string.max": "La valeur ne peut pas dépasser 255 caractères.",
  }),
  status: Joi.string().valid("CONFORME", "NON_CONFORME", "NON_CONTROLE").messages({
    "any.only": "Le statut du paramètre doit être CONFORME, NON_CONFORME ou NON_CONTROLE.",
  }),
  remark: Joi.string().allow("", null).max(2000).messages({
    "string.max": "La remarque ne peut pas dépasser 2000 caractères.",
  }),
});

const items = Joi.array().items(itemSchema).max(PARAMETER_KEYS.length).unique("parameterKey").messages({
  "array.unique": "Un même paramètre ne peut apparaître qu'une fois.",
});
const remark = Joi.string().allow("", null).max(2000);

// Paramètres physiques de la FICHE (valeur libre, indépendante des prélèvements).
const physical = Joi.array()
  .items(
    Joi.object({
      parameterKey: Joi.string().valid(...PHYSICAL_KEYS).required().messages({
        "any.only": "Paramètre physique inconnu.",
        "any.required": "Le paramètre est obligatoire.",
      }),
      value: Joi.string().allow("", null).max(255).messages({ "string.max": "La valeur ne peut pas dépasser 255 caractères." }),
      // Statut : pris en compte pour les paramètres qui en portent un
      // (contrôle spécifique des treillis GFRP).
      status: Joi.string().valid("CONFORME", "NON_CONFORME", "NON_CONTROLE").messages({
        "any.only": "Le statut du paramètre doit être CONFORME, NON_CONFORME ou NON_CONTROLE.",
      }),
      remark: Joi.string().allow("", null).max(2000),
    })
  )
  .max(PHYSICAL_KEYS.length)
  .unique("parameterKey")
  .messages({ "array.unique": "Un même paramètre ne peut apparaître qu'une fois." });

// Date calendaire réelle AAAA-MM-JJ (refuse 2026-02-30).
const isoDate = (label) =>
  Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .custom((v, helpers) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : helpers.error("any.invalid");
    })
    .messages({
      "string.pattern.base": `${label} : date invalide (AAAA-MM-JJ attendu).`,
      "any.invalid": `${label} : date invalide.`,
      "string.empty": `${label} : date obligatoire.`,
    });

const header = {
  controlDate: isoDate("Date d'ouverture"),
  controlTime: Joi.string()
    .pattern(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/)
    .messages({
      "string.pattern.base": "Heure d'ouverture : heure invalide (HH:mm:ss attendu).",
      "string.empty": "Heure d'ouverture : heure obligatoire.",
    }),
  productionDate: isoDate("Date de production"),
  poste: Joi.string()
    .valid(...cfg.postes)
    .messages({ "any.only": "Poste : Matin ou Soir uniquement.", "string.empty": "Poste : valeur obligatoire." }),
  // Saisie libre du contrôleur — vide autorisé (enregistré NULL).
  lot: Joi.string().trim().allow("", null).max(100).messages({ "string.max": "Lot : 100 caractères maximum." }),
  manufacturingOrder: Joi.string().trim().allow("", null).max(100).messages({
    "string.max": "Ordre de fabrication : 100 caractères maximum.",
  }),
};
const changeReason = Joi.string().allow("", null).max(1000);

// Heure du contrôle d'un prélèvement (HH:mm ; secondes tolérées, ignorées).
const readingTime = Joi.string()
  .pattern(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
  .messages({
    "string.pattern.base": "Heure du contrôle : heure invalide (HH:mm attendu).",
    "string.empty": "Heure du contrôle : heure obligatoire.",
    "any.required": "Heure du contrôle : heure obligatoire.",
  });

const result = Joi.string().valid("CONFORME", "NON_CONFORME").messages({
  "any.only": "Le résultat du contrôle doit être CONFORME ou NON_CONFORME.",
});

// Création : toute la saisie du formulaire « Nouveau contrôle » ;
// `validate: true` + `status` = créer ET valider dans une seule transaction.
// Fiche qualité d'une MACHINE : productionType + machine, obligatoires
// (vérifiés par le service contre la configuration). Le contrôle qualité est
// indépendant de la production : un éventuel productionRecordId est retiré
// (stripUnknown), jamais enregistré.
const createSchema = Joi.object({
  productionType: Joi.string().valid("PROMESH", "PROBAR", "promesh", "probar").required().messages({
    "any.required": "La ligne (PROMESH / PROBAR) est obligatoire.",
  }),
  machine: Joi.string().max(50).required().messages({ "any.required": "La machine est obligatoire." }),
  items,
  remark,
  physical,
  specific: physical,
  ...header,
  // Premier prélèvement de la fiche (heure, paramètres ; `validate` = valider le
  // PRÉLÈVEMENT). `items` / `readingTime` au premier niveau : même prélèvement.
  reading: Joi.object({ readingTime, items, validate: Joi.boolean(), status: result }),
  readingTime,
  // `validate` au premier niveau = valider la FICHE (et ses prélèvements).
  validate: Joi.boolean(),
  status: result,
});

// Prélèvements d'une fiche : POST (nouveau prélèvement — heure obligatoire), PUT et
// POST validate (prélèvement existant).
const readingCreateSchema = Joi.object({ readingTime: readingTime.required(), items, validate: Joi.boolean(), status: result });
const readingSaveSchema = Joi.object({ readingTime, items, status: result });

// `status` sur PUT : pris en compte uniquement pour un contrôle déjà validé
// (voir qualityControl.service.js#saveControl) — ignoré sinon.
// `physical` (paramètres physiques) et `specific` (contrôle spécifique des
// treillis GFRP) : paramètres de niveau FICHE, hors des prélèvements.
const updateSchema = Joi.object({ items, remark, physical, specific: physical, changeReason, status: result, ...header });

const validateSchema = Joi.object({ items, remark, physical, specific: physical, changeReason, status: result, ...header });

function validator(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body || {}, { abortEarly: false, stripUnknown: true });
    if (error) {
      return res.status(400).json({
        success: false,
        code: "INVALID_PAYLOAD",
        message: error.details.map((d) => d.message).join(" "),
      });
    }
    req.body = value;
    return next();
  };
}

// Recherche de la fiche de production (GET /production-match) — mêmes règles
// que l'en-tête ; ligne et machine vérifiées par le service.
const matchSchema = Joi.object({
  productionType: Joi.string().required().messages({ "any.required": "La ligne (PROMESH / PROBAR) est obligatoire." }),
  machine: Joi.string().max(50).required().messages({ "any.required": "La machine est obligatoire." }),
  productionDate: header.productionDate.required().messages({ "any.required": "Date de production obligatoire." }),
  poste: header.poste.required().messages({ "any.required": "Poste obligatoire." }),
});

function validateMatchQuery(req, res, next) {
  const { error, value } = matchSchema.validate(req.query || {}, { abortEarly: false, stripUnknown: true });
  if (error) {
    return res.status(400).json({ success: false, code: "INVALID_QUERY", message: error.details.map((d) => d.message).join(" ") });
  }
  req.matchQuery = value;
  return next();
}

module.exports = {
  validateMatchQuery,
  validateCreate: validator(createSchema),
  validateUpdate: validator(updateSchema),
  validateValidate: validator(validateSchema),
  validateReadingCreate: validator(readingCreateSchema),
  validateReadingSave: validator(readingSaveSchema),
};
