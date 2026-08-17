"use strict";

const { Op, literal } = require("sequelize");
const FinanceDocument = require("../../../models/FinanceDocument");
const FinanceShipment = require("../../../models/FinanceShipment");
const FinanceShipmentItem = require("../../../models/FinanceShipmentItem");
const FinanceInvoice = require("../../../models/FinanceInvoice");
const FinanceInvoiceItem = require("../../../models/FinanceInvoiceItem");
const FinanceInvoiceTax = require("../../../models/FinanceInvoiceTax");
const FinancePayment = require("../../../models/FinancePayment");
const FinanceActivity = require("../../../models/FinanceActivity");
const FinancePurchaseOrder = require("../../../models/FinancePurchaseOrder");
const FinancePurchaseOrderItem = require("../../../models/FinancePurchaseOrderItem");
const Client = require("../../../models/client.model");
const User = require("../../../models/User");
require("../../../models/associations");

const USER_ATTRS = ["id", "email"];

// ── DOCUMENTS ─────────────────────────────────────────────────────────────

function createDocument(data, options) {
  return FinanceDocument.create(data, options);
}

// Récupère en UNE requête les documents de plusieurs shipments à la fois
// (module SHIPMENT, entityId IN [...]) — utilisé par la liste "Customer
// shipments" pour afficher les documents associés à chaque ligne sans N+1.
// entityId reste une référence douce (voir associations.js), donc pas
// d'`include` Sequelize possible ici : un second SELECT groupé fait le même
// travail sans faux-FK.
function findDocumentsByEntityIds(module, entityIds) {
  if (!entityIds.length) return Promise.resolve([]);
  return FinanceDocument.findAll({
    where: { module, entityId: { [Op.in]: entityIds } },
    include: [{ model: User, as: "uploader", attributes: USER_ATTRS }],
    order: [["createdAt", "DESC"]],
  });
}

function findDocuments(where = {}, { limit, offset } = {}) {
  return FinanceDocument.findAll({
    where,
    include: [{ model: User, as: "uploader", attributes: USER_ATTRS }],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });
}

function countDocuments(where = {}) {
  return FinanceDocument.count({ where });
}

function findDocumentById(id) {
  return FinanceDocument.findByPk(id, { include: [{ model: User, as: "uploader", attributes: USER_ATTRS }] });
}

function destroyDocument(instance, options) {
  return instance.destroy(options);
}

function documentSearchClause(term) {
  const like = `%${term}%`;
  return { originalName: { [Op.iLike]: like } };
}

// ── SHIPMENTS ─────────────────────────────────────────────────────────────

const SHIPMENT_INCLUDE = [
  { model: Client, as: "customer" },
  { model: User, as: "creator", attributes: USER_ATTRS },
  // Colonne "Invoice" (§7) — quelles factures existent déjà pour ce
  // shipment, sans requête N+1 supplémentaire côté service.
  { model: FinanceInvoice, as: "invoices", attributes: ["id", "invoiceNumber", "status"] },
  // Lignes produit extraites du Bon de Livraison (OCR) — `separate: true`
  // évite le produit cartésien avec l'include "invoices" (même raisonnement
  // que pour FinanceInvoiceItem : deux hasMany + pagination = requête à part).
  { model: FinanceShipmentItem, as: "items", separate: true, order: [["sortOrder", "ASC"]] },
];

function createShipment(data, options) {
  return FinanceShipment.create(data, options);
}

// Lignes produit d'un Bon de Livraison (§ Products) — un seul bulkCreate par
// shipment, dans la même transaction que sa création (voir
// finance.service.js#processShipmentUpload).
function createShipmentItems(rows, options) {
  if (!rows.length) return Promise.resolve([]);
  return FinanceShipmentItem.bulkCreate(rows, options);
}

function findShipments(where = {}, { limit, offset } = {}) {
  return FinanceShipment.findAll({
    where,
    include: SHIPMENT_INCLUDE,
    order: [["shipmentDate", "DESC"], ["createdAt", "DESC"]],
    limit,
    offset,
  });
}

function countShipments(where = {}, options = {}) {
  return FinanceShipment.count({ where, ...options });
}

function findShipmentById(id) {
  return FinanceShipment.findByPk(id, { include: SHIPMENT_INCLUDE });
}

function updateShipment(instance, data) {
  return instance.update(data);
}

function shipmentSearchClause(term) {
  const like = `%${term}%`;
  return { reference: { [Op.iLike]: like } };
}

// ── INVOICES ──────────────────────────────────────────────────────────────

const INVOICE_INCLUDE = [
  { model: Client, as: "customer" },
  { model: FinanceShipment, as: "shipment" },
  { model: FinancePayment, as: "payments" },
  { model: FinanceInvoiceItem, as: "items", separate: true, order: [["sortOrder", "ASC"]] },
  { model: FinanceInvoiceTax, as: "taxes", separate: true, order: [["sortOrder", "ASC"]] },
  { model: User, as: "creator", attributes: USER_ATTRS },
];

function createInvoice(data, options) {
  return FinanceInvoice.create(data, options);
}

// Lignes de facture extraites par OCR (§ Invoice items) — un seul
// bulkCreate par facture, dans la même transaction que la création de
// l'Invoice (voir finance.service.js#processInvoiceUpload).
function createInvoiceItems(rows, options) {
  if (!rows.length) return Promise.resolve([]);
  return FinanceInvoiceItem.bulkCreate(rows, options);
}

// Lignes de taxes du bloc fiscal extraites par OCR (§ TAXES) — même
// principe, un seul bulkCreate dans la transaction de création.
function createInvoiceTaxes(rows, options) {
  if (!rows.length) return Promise.resolve([]);
  return FinanceInvoiceTax.bulkCreate(rows, options);
}

function findInvoices(where = {}, { limit, offset } = {}) {
  return FinanceInvoice.findAll({
    where,
    include: INVOICE_INCLUDE,
    order: [["invoiceDate", "DESC"], ["createdAt", "DESC"]],
    limit,
    offset,
  });
}

function countInvoices(where = {}, options = {}) {
  return FinanceInvoice.count({ where, ...options });
}

function findInvoiceById(id) {
  return FinanceInvoice.findByPk(id, { include: INVOICE_INCLUDE });
}

function updateInvoice(instance, data, options) {
  return instance.update(data, options);
}

function sumInvoiceAmount(where = {}) {
  return FinanceInvoice.sum("total", { where });
}

// Recherche libre invoice #/customer/shipment # (§8) — IMPORTANT : utilise
// des sous-requêtes corrélées auto-suffisantes (jamais un alias de jointure
// type "$customer.raisonSociale$"), car findInvoices() pagine avec `limit`
// sur une association hasMany (payments), ce qui force Sequelize à
// envelopper la requête dans une sous-requête interne où les alias de JOIN
// externes n'existent pas encore — Postgres lève alors "missing FROM-clause
// entry". Une sous-requête IN (...) autonome par colonne fonctionne dans
// les deux cas (avec ou sans le wrapping subQuery de Sequelize) et reste
// paramétrée via sequelize.escape() (pas d'injection SQL).
function invoiceSearchClause(term) {
  const like = `%${term}%`;
  const likeEscaped = FinanceInvoice.sequelize.escape(like); // ex: 'FOO%' — guillemets déjà inclus, sûr à interpoler
  return {
    [Op.or]: [
      { invoiceNumber: { [Op.iLike]: like } },
      { customerId: { [Op.in]: literal(`(SELECT id FROM clients WHERE "raisonSociale" ILIKE ${likeEscaped})`) } },
      { shipmentId: { [Op.in]: literal(`(SELECT id FROM finance_shipments WHERE reference ILIKE ${likeEscaped})`) } },
    ],
  };
}

// ── PURCHASE ORDERS (Inflow of raw materials) ──────────────────────────────

const PURCHASE_ORDER_INCLUDE = [
  { model: Client, as: "customer" },
  { model: User, as: "creator", attributes: USER_ATTRS },
  { model: FinancePurchaseOrderItem, as: "items", separate: true, order: [["sortOrder", "ASC"]] },
];

function createPurchaseOrder(data, options) {
  return FinancePurchaseOrder.create(data, options);
}

// Lignes du Bon de Commande extraites par OCR — un seul bulkCreate par bon,
// dans la même transaction que sa création.
function createPurchaseOrderItems(rows, options) {
  if (!rows.length) return Promise.resolve([]);
  return FinancePurchaseOrderItem.bulkCreate(rows, options);
}

function findPurchaseOrders(where = {}, { limit, offset } = {}) {
  return FinancePurchaseOrder.findAll({
    where,
    include: PURCHASE_ORDER_INCLUDE,
    order: [["orderDate", "DESC"], ["createdAt", "DESC"]],
    limit,
    offset,
  });
}

function countPurchaseOrders(where = {}) {
  return FinancePurchaseOrder.count({ where });
}

function findPurchaseOrderById(id) {
  return FinancePurchaseOrder.findByPk(id, { include: PURCHASE_ORDER_INCLUDE });
}

function purchaseOrderSearchClause(term) {
  const like = `%${term}%`;
  return {
    [Op.or]: [{ orderNumber: { [Op.iLike]: like } }, { customerName: { [Op.iLike]: like } }],
  };
}

// ── PAYMENTS ──────────────────────────────────────────────────────────────

function createPayment(data, options) {
  return FinancePayment.create(data, options);
}

function findPaymentById(id) {
  return FinancePayment.findByPk(id);
}

function sumPaymentAmountForInvoice(invoiceId, options) {
  return FinancePayment.sum("amount", { where: { invoiceId }, ...options });
}

// Total payé toutes factures confondues — KPI "Total paid amount" du
// dashboard (§4), aucun filtre nécessaire pour l'instant.
function sumPaymentAmount() {
  return FinancePayment.sum("amount");
}

// ── ACTIVITY LOG ──────────────────────────────────────────────────────────

function logActivity({ entityType, entityId, userId, type, message, metadata }, options) {
  return FinanceActivity.create({ entityType, entityId, userId, type, message, metadata }, options);
}

module.exports = {
  createDocument,
  findDocuments,
  countDocuments,
  findDocumentById,
  destroyDocument,
  documentSearchClause,
  findDocumentsByEntityIds,

  createShipment,
  createShipmentItems,
  findShipments,
  countShipments,
  findShipmentById,
  updateShipment,
  shipmentSearchClause,

  createInvoice,
  createInvoiceItems,
  createInvoiceTaxes,
  findInvoices,
  countInvoices,
  findInvoiceById,
  updateInvoice,
  sumInvoiceAmount,
  invoiceSearchClause,

  createPurchaseOrder,
  createPurchaseOrderItems,
  findPurchaseOrders,
  countPurchaseOrders,
  findPurchaseOrderById,
  purchaseOrderSearchClause,

  createPayment,
  findPaymentById,
  sumPaymentAmountForInvoice,
  sumPaymentAmount,

  logActivity,
};
