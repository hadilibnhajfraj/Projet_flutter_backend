"use strict";

const Joi = require("joi");
const cfg = require("../../../config/qualityControl");

const PARAMETER_KEYS = cfg.parameters.map((p) => p.key);

// Date/heure/utilisateur/machine/poste ne sont JAMAIS acceptés du client :
// posés par le serveur (voir qualityControl.service.js) — `stripUnknown`
// les retire silencieusement s'ils sont envoyés.
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
const changeReason = Joi.string().allow("", null).max(1000);

const createSchema = Joi.object({
  productionRecordId: Joi.string().required().messages({ "any.required": "La fiche de production est obligatoire." }),
  productionType: Joi.string().valid("PROMESH", "PROBAR", "promesh", "probar"),
  items,
  remark,
});

const result = Joi.string().valid("CONFORME", "NON_CONFORME").messages({
  "any.only": "Le résultat du contrôle doit être CONFORME ou NON_CONFORME.",
});

// `status` sur PUT : pris en compte uniquement pour un contrôle déjà validé
// (voir qualityControl.service.js#saveControl) — ignoré sinon.
const updateSchema = Joi.object({ items, remark, changeReason, status: result });

const validateSchema = Joi.object({ items, remark, changeReason, status: result });

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

module.exports = {
  validateCreate: validator(createSchema),
  validateUpdate: validator(updateSchema),
  validateValidate: validator(validateSchema),
};
