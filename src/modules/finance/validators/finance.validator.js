"use strict";

const Joi = require("joi");

const productLineSchema = Joi.object({
  designation: Joi.string().max(255).allow("", null).optional(),
  quantity: Joi.number().min(0).allow(null).empty("").optional(),
  unit: Joi.string().max(50).allow("", null).optional(),
});

const SHIPMENT_STATUSES = ["DRAFT", "PREPARED", "SHIPPED", "DELIVERED", "CANCELLED"];

// "New shipment" simplifié : le formulaire ne collecte plus que des
// documents — reference/customerId/shipmentDate/products/totalAmount sont
// tous optionnels (reference auto-générée, statut DRAFT par défaut côté
// service si absents). Conservés ici en optionnel plutôt que supprimés pour
// ne pas casser un futur appelant qui voudrait les fournir explicitement.
const createShipmentSchema = Joi.object({
  reference: Joi.string().max(100).allow("", null).optional(),
  customerId: Joi.number().integer().allow(null).empty("").optional(),
  shipmentDate: Joi.date().iso().allow(null).empty("").optional(),
  products: Joi.array().items(productLineSchema).default([]),
  totalQuantity: Joi.number().min(0).allow(null).empty("").optional(),
  totalAmount: Joi.number().min(0).allow(null).empty("").optional(),
  deliveryInfo: Joi.string().max(5000).allow("", null).optional(),
  status: Joi.string().valid(...SHIPMENT_STATUSES).optional(),
});

const updateShipmentSchema = Joi.object({
  reference: Joi.string().max(100).optional(),
  customerId: Joi.number().integer().optional(),
  shipmentDate: Joi.date().iso().optional(),
  products: Joi.array().items(productLineSchema).optional(),
  totalQuantity: Joi.number().min(0).allow(null).empty("").optional(),
  totalAmount: Joi.number().min(0).allow(null).empty("").optional(),
  deliveryInfo: Joi.string().max(5000).allow("", null).optional(),
  status: Joi.string().valid(...SHIPMENT_STATUSES).optional(),
}).min(1);

// "Upload invoice" simplifié : le modal ne collecte plus que des documents —
// invoiceNumber/customerId/invoiceDate/amount sont tous optionnels ici
// (invoiceNumber auto-généré, statut par défaut du modèle si absents). La
// règle "customerId/invoiceDate/amount requis en l'absence de documents" est
// appliquée côté service (finance.service.js#createInvoice), qui a seul
// accès à req.files pour savoir quel flux est utilisé.
const createInvoiceSchema = Joi.object({
  invoiceNumber: Joi.string().max(100).allow("", null).optional(),
  shipmentId: Joi.string().guid({ version: "uuidv4" }).allow("", null).optional(),
  customerId: Joi.number().integer().allow(null).empty("").optional(),
  invoiceDate: Joi.date().iso().allow(null).empty("").optional(),
  amount: Joi.number().min(0).allow(null).empty("").optional(),
  tax: Joi.number().min(0).allow(null).empty("").optional(),
  total: Joi.number().min(0).allow(null).empty("").optional(),
});

// "Register payment" (§MODIFIER LE WORKFLOW PAYMENT / PAID FACTURES) —
// formulaire minimal : dropdown FERMÉ à exactement ces 4 valeurs + un
// justificatif (obligatoire, vérifié côté service — voir
// finance.service.js#registerPayment, req.file n'est pas dans req.body donc
// pas validable ici). `amount`/`paidDate` ne sont plus saisis par
// l'utilisateur (§5 : ne rien exiger d'autre que la méthode) — optionnels
// ici, le service les déduit (montant total de la facture / date de
// règlement extraite par OCR) quand absents. Les champs Chèque/Traite
// restent optionnels et inutilisés par le nouveau formulaire, mais on les
// garde acceptés pour ne rien casser côté backend (§13).
const PAYMENT_METHODS = ["Virement", "Versement", "Chèque", "Traite"];

const registerPaymentSchema = Joi.object({
  amount: Joi.number().greater(0).empty("").optional(),
  paidDate: Joi.date().iso().empty("").optional(),
  method: Joi.string().valid(...PAYMENT_METHODS).required(),
  reference: Joi.string().max(150).allow("", null).optional(),
  chequeNumber: Joi.string().max(100).allow("", null).optional(),
  bankName: Joi.string().max(150).allow("", null).optional(),
  chequeDate: Joi.date().iso().allow(null).empty("").optional(),
  billOfExchangeNumber: Joi.string().max(100).allow("", null).optional(),
  dueDate: Joi.date().iso().allow(null).empty("").optional(),
});

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
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
  validateCreateShipment: validate(createShipmentSchema),
  validateUpdateShipment: validate(updateShipmentSchema),
  validateCreateInvoice: validate(createInvoiceSchema),
  validateRegisterPayment: validate(registerPaymentSchema),
  PAYMENT_METHODS,
};
