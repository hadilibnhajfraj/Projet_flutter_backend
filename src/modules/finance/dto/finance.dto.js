"use strict";

/**
 * Strips internal Sequelize fields and normalises Finance records for API responses.
 */

const deliveryNoteValidation = require("../services/deliveryNoteValidation.service");
const invoiceValidation = require("../services/invoiceValidation.service");

function toUserRef(user) {
  if (!user) return null;
  const u = user.toJSON ? user.toJSON() : user;
  return { id: u.id, email: u.email };
}

function toCustomerRef(client) {
  if (!client) return null;
  const c = client.toJSON ? client.toJSON() : client;
  return {
    id: c.id,
    raisonSociale: c.raisonSociale,
    matriculeFiscal: c.matriculeFiscal,
    contact: c.contact,
  };
}

function toDocumentResponse(doc) {
  if (!doc) return null;
  const d = doc.toJSON ? doc.toJSON() : doc;
  return {
    id: d.id,
    module: d.module,
    entityId: d.entityId,
    originalName: d.originalName,
    // §MODIFICATION — FINANCE > OTHER : nom d'affichage modifiable (§7/§19).
    // Retombe sur `originalName` pour tout document créé avant l'ajout de ce
    // champ ou par un autre module — jamais `null` côté frontend.
    displayName: d.displayName ?? d.originalName,
    fileUrl: d.fileUrl,
    mimeType: d.mimeType,
    fileSize: d.fileSize,
    status: d.status,
    uploadedBy: d.uploadedBy,
    uploader: toUserRef(d.uploader),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toDocumentList(docs) {
  return (docs || []).map(toDocumentResponse);
}

function toInvoiceRef(invoice) {
  if (!invoice) return null;
  const i = invoice.toJSON ? invoice.toJSON() : invoice;
  return { id: i.id, invoiceNumber: i.invoiceNumber };
}

function toShipmentItemResponse(item) {
  if (!item) return null;
  const it = item.toJSON ? item.toJSON() : item;
  return {
    id: it.id,
    sortOrder: it.sortOrder,
    reference: it.reference,
    designation: it.designation,
    unit: it.unit,
    diameter: it.diameter,
    meshSize: it.meshSize,
    quantity: it.quantity,
  };
}

function toShipmentResponse(shipment) {
  if (!shipment) return null;
  const s = shipment.toJSON ? shipment.toJSON() : shipment;
  return {
    id: s.id,
    shipmentNumber: s.shipmentNumber,
    reference: s.reference,
    customerReference: s.customerReference,
    customerId: s.customerId,
    customer: toCustomerRef(s.customer),
    customerName: s.customerName,
    customerPhone: s.customerPhone,
    customerAddress: s.customerAddress,
    customerGovernorate: s.customerGovernorate,
    customerTaxId: s.customerTaxId,
    customerCode: s.customerCode,
    customerHeadOfficeAddress: s.customerHeadOfficeAddress,
    truckRegistration: s.truckRegistration,
    truckManufacturer: s.truckManufacturer,
    driverName: s.driverName,
    deliveryAddress: s.deliveryAddress,
    shipmentDate: s.shipmentDate,
    products: s.products || [],
    totalQuantity: s.totalQuantity,
    totalAmount: s.totalAmount,
    deliveryInfo: s.deliveryInfo,
    status: s.status,
    ocrConfidence: s.ocrConfidence,
    // §CORRECTION — WORKFLOW OCR CUSTOMER SHIPMENTS (2026-08-31) : `reference`
    // n'est PAS un équivalent fiable de `FinancePurchaseOrder.orderNumber`
    // pour décider si l'extraction est exploitable — contrairement à
    // `orderNumber` (nullable, jamais généré), `reference` reçoit TOUJOURS
    // une valeur (repli `generateShipmentReference` quand l'OCR n'a rien lu
    // de fiable, voir finance_shipments.reference: allowNull:false, unique).
    // Un champ distinct était donc nécessaire pour exposer le MÊME signal
    // que Purchase Orders tirent de `orderNumber == null` : recalculé ici
    // depuis `ocrExtraction.deliveryNumber` (déjà stocké à l'upload, jamais
    // une deuxième extraction) avec le MÊME seuil de confiance
    // (deliveryNoteValidation.CONFIDENCE_THRESHOLD) que celui utilisé pour
    // décider `hasReliableDeliveryNumber` côté service au moment de la
    // création.
    hasReliableReference:
      Boolean(s.ocrExtraction?.deliveryNumber?.value) &&
      (s.ocrExtraction?.deliveryNumber?.confidence ?? 0) >= deliveryNoteValidation.CONFIDENCE_THRESHOLD,
    invoices: (s.invoices || []).map(toInvoiceRef),
    items: (s.items || []).map(toShipmentItemResponse),
    documents: toDocumentList(s.documents || []),
    createdBy: s.createdBy,
    creator: toUserRef(s.creator),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function toShipmentList(shipments) {
  return (shipments || []).map(toShipmentResponse);
}

function toPaymentResponse(payment) {
  if (!payment) return null;
  const p = payment.toJSON ? payment.toJSON() : payment;
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    amount: p.amount,
    paidDate: p.paidDate,
    method: p.method,
    reference: p.reference,
    chequeNumber: p.chequeNumber,
    bankName: p.bankName,
    chequeDate: p.chequeDate,
    billOfExchangeNumber: p.billOfExchangeNumber,
    dueDate: p.dueDate,
    documents: toDocumentList(p.documents || []),
    registeredBy: p.registeredBy,
    createdAt: p.createdAt,
  };
}

function toInvoiceItemResponse(item) {
  if (!item) return null;
  const it = item.toJSON ? item.toJSON() : item;
  return {
    id: it.id,
    sortOrder: it.sortOrder,
    reference: it.reference,
    designation: it.designation,
    unit: it.unit,
    diameter: it.diameter,
    meshSize: it.meshSize,
    quantity: it.quantity,
    unitPriceHT: it.unitPriceHT,
    rms: it.rms,
    amountHT: it.amountHT,
    tax1: it.tax1,
    tax2: it.tax2,
  };
}

function toInvoiceTaxResponse(tax) {
  if (!tax) return null;
  const t = tax.toJSON ? tax.toJSON() : tax;
  return {
    id: t.id,
    sortOrder: t.sortOrder,
    code: t.code,
    base: t.base,
    rate: t.rate,
    amount: t.amount,
  };
}

function toInvoiceResponse(invoice) {
  if (!invoice) return null;
  const i = invoice.toJSON ? invoice.toJSON() : invoice;
  return {
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    reference: i.reference,
    shipmentId: i.shipmentId,
    shipment: i.shipment ? { id: i.shipment.id, reference: i.shipment.reference } : null,
    customerId: i.customerId,
    customer: toCustomerRef(i.customer),
    customerName: i.customerName,
    customerPhone: i.customerPhone,
    customerAddress: i.customerAddress,
    customerGovernorate: i.customerGovernorate,
    customerTaxId: i.customerTaxId,
    customerCode: i.customerCode,
    invoiceDate: i.invoiceDate,
    amount: i.amount,
    tax: i.tax,
    total: i.total,
    // §CORRECTION — WORKFLOW OCR FACTURED SHIPMENTS (2026-08-31) : même
    // raisonnement que `hasReliableReference` sur les Shipments ci-dessus —
    // `invoiceNumber` reçoit TOUJOURS une valeur (repli auto-généré quand
    // l'OCR ne trouve rien de fiable, voir finance_invoices.invoiceNumber :
    // allowNull:false, unique) et ne peut donc pas jouer, côté frontend, le
    // rôle que joue `orderNumber` (nullable) pour les Purchase Orders.
    // Recalculé depuis `ocrExtraction.invoiceNumber`, déjà stocké à
    // l'upload, avec le même seuil de confiance que celui utilisé pour
    // décider `invoiceNumber`/`status` à la création.
    hasReliableInvoiceNumber:
      Boolean(i.ocrExtraction?.invoiceNumber?.value) &&
      (i.ocrExtraction?.invoiceNumber?.confidence ?? 0) >= invoiceValidation.CONFIDENCE_THRESHOLD,
    downPayment: i.downPayment,
    netToPay: i.netToPay,
    paymentCondition: i.paymentCondition,
    paymentDate: i.paymentDate,
    paymentMethod: i.paymentMethod,
    amountInWords: i.amountInWords,
    ocrConfidence: i.ocrConfidence,
    // §MODIFICATION — SCAN / OCR DES FACTURES : SUPPORT DE 2 FORMATS. Le
    // format fournisseur/NADEC n'a pas de colonnes DB dédiées pour
    // supplier{}/references{blNumber,bcNumber} (aucune migration nécessaire,
    // ces informations n'existent nulle part ailleurs qu'ici) — exposées en
    // LECTURE SEULE depuis le JSONB `ocrExtraction` déjà stocké à
    // l'extraction, jamais recalculées. `null` pour les factures SAGE (rien
    // à mélanger) et pour les factures créées via le flux JSON historique
    // (aucune extraction OCR effectuée).
    format: i.ocrExtraction?.format ?? null,
    supplier: i.ocrExtraction?.supplier ?? null,
    references: i.ocrExtraction?.references ?? null,
    // §CORRECTION PRIORITAIRE — EXTRACTION OCR FACTURE NADEC : mêmes
    // garanties que supplier/references ci-dessus (lecture seule depuis
    // `ocrExtraction`, `null` pour SAGE/flux JSON historique).
    operator: i.ocrExtraction?.operator ?? null,
    seller: i.ocrExtraction?.seller ?? null,
    page: i.ocrExtraction?.page ?? null,
    taxesZone: i.ocrExtraction?.taxesZone ?? null,
    taxes: (i.taxes || []).map(toInvoiceTaxResponse),
    payments: (i.payments || []).map(toPaymentResponse),
    items: (i.items || []).map(toInvoiceItemResponse),
    documents: toDocumentList(i.documents || []),
    createdBy: i.createdBy,
    creator: toUserRef(i.creator),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

function toInvoiceList(invoices) {
  return (invoices || []).map(toInvoiceResponse);
}

function toPurchaseOrderItemResponse(item) {
  if (!item) return null;
  const it = item.toJSON ? item.toJSON() : item;
  return {
    id: it.id,
    sortOrder: it.sortOrder,
    reference: it.reference,
    designation: it.designation,
    unit: it.unit,
    quantity: it.quantity,
    unitPriceHT: it.unitPriceHT,
    amountHT: it.amountHT,
  };
}

function toPurchaseOrderResponse(order) {
  if (!order) return null;
  const o = order.toJSON ? order.toJSON() : order;
  return {
    id: o.id,
    poNumber: o.poNumber,
    orderNumber: o.orderNumber,
    orderDate: o.orderDate,
    customerId: o.customerId,
    customer: toCustomerRef(o.customer),
    customerCode: o.customerCode,
    customerName: o.customerName,
    customerAddress: o.customerAddress,
    deliveryAddress: o.deliveryAddress,
    totalHT: o.totalHT,
    ocrConfidence: o.ocrConfidence,
    status: o.status,
    items: (o.items || []).map(toPurchaseOrderItemResponse),
    documents: toDocumentList(o.documents || []),
    createdBy: o.createdBy,
    creator: toUserRef(o.creator),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function toPurchaseOrderList(orders) {
  return (orders || []).map(toPurchaseOrderResponse);
}

module.exports = {
  toDocumentResponse,
  toDocumentList,
  toShipmentResponse,
  toShipmentList,
  toInvoiceResponse,
  toInvoiceList,
  toPurchaseOrderResponse,
  toPurchaseOrderList,
  toPaymentResponse,
};
