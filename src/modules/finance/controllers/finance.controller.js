"use strict";

const svc = require("../services/finance.service");
const dto = require("../dto/finance.dto");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("Finance error:", err);
  res.status(status).json({ success: false, message: err.message || "Internal server error" });
}

function actorFrom(req) {
  return { id: req.user.sub, role: req.user.role, email: req.user.email };
}

async function getDashboard(req, res) {
  try {
    const { startDate, endDate, customer, paymentMethod } = req.query;
    const data = await svc.getDashboard({ startDate, endDate, customer, paymentMethod });
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function getDashboardMonthly(req, res) {
  try {
    const { startDate, endDate, customer, paymentMethod } = req.query;
    const data = await svc.getDashboardMonthly({ startDate, endDate, customer, paymentMethod });
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// ── Inflow of raw materials ────────────────────────────────────────────

async function listRawMaterials(req, res) {
  try {
    const { search, page, pageSize } = req.query;
    const { data, total, page: p, pageSize: ps } = await svc.listRawMaterials({ search, page, pageSize });
    res.json({ success: true, count: total, page: p, pageSize: ps, data: dto.toPurchaseOrderList(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function uploadRawMaterial(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "Fichier requis" });
    const { order, documents } = await svc.processRawMaterialUpload(req.file, actorFrom(req));
    res.status(201).json({ success: true, data: { ...dto.toPurchaseOrderResponse(order), documents: dto.toDocumentList(documents) } });
  } catch (err) {
    handle(res, err);
  }
}

async function getRawMaterial(req, res) {
  try {
    const { order, documents } = await svc.getRawMaterial(req.params.id);
    res.json({ success: true, data: { ...dto.toPurchaseOrderResponse(order), documents: dto.toDocumentList(documents) } });
  } catch (err) {
    handle(res, err);
  }
}

// §MODIFICATION — INFLOW RAW MATERIALS : "Order date" éditable directement
// depuis le tableau (req.body déjà validé par validateUpdatePurchaseOrder).
async function updateRawMaterial(req, res) {
  try {
    const { order, documents } = await svc.updateRawMaterial(req.params.id, req.body, actorFrom(req));
    res.json({ success: true, data: { ...dto.toPurchaseOrderResponse(order), documents: dto.toDocumentList(documents) } });
  } catch (err) {
    handle(res, err);
  }
}

async function deleteRawMaterial(req, res) {
  try {
    await svc.deleteRawMaterial(req.params.id, actorFrom(req));
    res.json({ success: true, message: "Purchase order deleted successfully" });
  } catch (err) {
    handle(res, err);
  }
}

// §MODIFICATION — SCAN DOCUMENTS (INCLUDE IMPORT) : PLUSIEURS DOCUMENTS PAR
// LIGNE (2026-09-01) — ajoute N document(s) à un bon de commande EXISTANT
// (jamais une nouvelle ligne créée, voir uploadRawMaterial ci-dessus pour la
// création réelle par OCR).
async function addRawMaterialDocuments(req, res) {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ success: false, message: "Au moins un fichier est requis" });
    const { order, documents } = await svc.addRawMaterialDocuments(req.params.id, req.files, actorFrom(req));
    res.status(201).json({ success: true, data: { ...dto.toPurchaseOrderResponse(order), documents: dto.toDocumentList(documents) } });
  } catch (err) {
    handle(res, err);
  }
}

// §9 du ticket : supprime UN SEUL document, jamais le bon de commande entier.
async function deleteRawMaterialDocument(req, res) {
  try {
    const { order, documents } = await svc.deleteRawMaterialDocument(req.params.id, req.params.docId, actorFrom(req));
    res.json({ success: true, data: { ...dto.toPurchaseOrderResponse(order), documents: dto.toDocumentList(documents) } });
  } catch (err) {
    handle(res, err);
  }
}

// ── Finance > Other (§MODIFICATION — SCAN SIMPLE DE DOCUMENTS) ──────────
// Stockage documentaire pur — jamais d'OCR/extraction déclenché ici (voir
// finance.service.js#uploadOtherDocument).

async function listOtherDocuments(req, res) {
  try {
    const { search, type, startDate, endDate, page, pageSize } = req.query;
    const { data, total, page: p, pageSize: ps } = await svc.listOtherDocuments({ search, type, startDate, endDate, page, pageSize });
    res.json({ success: true, count: total, page: p, pageSize: ps, data: dto.toDocumentList(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function uploadOtherDocument(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "Fichier requis" });
    const document = await svc.uploadOtherDocument(req.file, actorFrom(req));
    res.status(201).json({ success: true, message: "Document uploaded successfully", data: dto.toDocumentResponse(document) });
  } catch (err) {
    handle(res, err);
  }
}

async function renameOtherDocument(req, res) {
  try {
    const document = await svc.renameOtherDocument(req.params.id, req.body?.displayName, actorFrom(req));
    res.json({ success: true, message: "Document renamed successfully", data: dto.toDocumentResponse(document) });
  } catch (err) {
    handle(res, err);
  }
}

async function deleteOtherDocument(req, res) {
  try {
    await svc.deleteOtherDocument(req.params.id, actorFrom(req));
    res.json({ success: true, message: "Document deleted successfully" });
  } catch (err) {
    handle(res, err);
  }
}

// ── Sous-menu "Import" (MODIFICATION CRM — AJOUTER UN SOUS-MENU IMPORT À
// CHAQUE MENU FINANCE) — mêmes 4 opérations que "Finance > Other" ci-dessus
// (list/upload/rename/delete), réutilisées TELLES QUELLES via
// svc.*ImportDocument (voir finance.service.js), jamais une seconde
// implémentation d'upload/OCR : ces 4 handlers ne sont que de fines
// enveloppes qui fixent `module` selon la page appelante (voir
// finance.routes.js — un jeu de 4 routes par module, chacune liée à l'un
// des handlers ci-dessous).
function makeImportHandlers(module) {
  return {
    async list(req, res) {
      try {
        const { search, type, startDate, endDate, page, pageSize } = req.query;
        const { data, total, page: p, pageSize: ps } = await svc.listImportDocuments(module, {
          search,
          type,
          startDate,
          endDate,
          page,
          pageSize,
        });
        res.json({ success: true, count: total, page: p, pageSize: ps, data: dto.toDocumentList(data) });
      } catch (err) {
        handle(res, err);
      }
    },
    async upload(req, res) {
      try {
        if (!req.file) return res.status(400).json({ success: false, message: "Fichier requis" });
        const document = await svc.uploadImportDocument(module, req.file, actorFrom(req));
        res.status(201).json({ success: true, message: "Document uploaded successfully", data: dto.toDocumentResponse(document) });
      } catch (err) {
        handle(res, err);
      }
    },
    async rename(req, res) {
      try {
        const document = await svc.renameImportDocument(module, req.params.id, req.body?.displayName, actorFrom(req));
        res.json({ success: true, message: "Document renamed successfully", data: dto.toDocumentResponse(document) });
      } catch (err) {
        handle(res, err);
      }
    },
    async remove(req, res) {
      try {
        await svc.deleteImportDocument(module, req.params.id, actorFrom(req));
        res.json({ success: true, message: "Document deleted successfully" });
      } catch (err) {
        handle(res, err);
      }
    },
  };
}

const rawMaterialsImport = makeImportHandlers(svc.RAW_MATERIALS_MODULE);
const shipmentsImport = makeImportHandlers(svc.SHIPMENT_MODULE);
const facturedShipmentsImport = makeImportHandlers(svc.INVOICE_MODULE);
const paidInvoicesImport = makeImportHandlers(svc.PAID_INVOICE_IMPORT_MODULE);

// ── Shipment of products to the customers ──────────────────────────────

async function listShipments(req, res) {
  try {
    const { search, status, customerId, page, pageSize } = req.query;
    const { data, total, page: p, pageSize: ps } = await svc.listShipments({ search, status, customerId, page, pageSize });
    res.json({ success: true, count: total, page: p, pageSize: ps, data: dto.toShipmentList(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function createShipment(req, res) {
  try {
    const data = await svc.createShipment(req.body, actorFrom(req), req.files || []);
    res.status(201).json({ success: true, data: dto.toShipmentResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function getShipment(req, res) {
  try {
    const { shipment, documents } = await svc.getShipment(req.params.id);
    res.json({ success: true, data: { ...dto.toShipmentResponse(shipment), documents: dto.toDocumentList(documents) } });
  } catch (err) {
    handle(res, err);
  }
}

async function updateShipment(req, res) {
  try {
    const data = await svc.updateShipment(req.params.id, req.body, actorFrom(req));
    res.json({ success: true, data: dto.toShipmentResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function deleteShipment(req, res) {
  try {
    await svc.deleteShipment(req.params.id, actorFrom(req));
    res.json({ success: true, message: "Shipment deleted successfully" });
  } catch (err) {
    handle(res, err);
  }
}

// ── Factured shipments / Paid factures ─────────────────────────────────

async function listInvoices(req, res) {
  try {
    const { search, status, customerId, startDate, endDate, page, pageSize } = req.query;
    const { data, total, page: p, pageSize: ps } = await svc.listInvoices({
      search,
      status,
      customerId,
      startDate,
      endDate,
      page,
      pageSize,
    });
    res.json({ success: true, count: total, page: p, pageSize: ps, data: dto.toInvoiceList(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function listPaidInvoices(req, res) {
  try {
    const { search, customerId, startDate, endDate, page, pageSize } = req.query;
    const { data, total, page: p, pageSize: ps } = await svc.listPaidInvoices({
      search,
      customerId,
      startDate,
      endDate,
      page,
      pageSize,
    });
    res.json({ success: true, count: total, page: p, pageSize: ps, data: dto.toInvoiceList(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function getInvoice(req, res) {
  try {
    const { invoice, documents } = await svc.getInvoice(req.params.id);
    res.json({ success: true, data: { ...dto.toInvoiceResponse(invoice), documents: dto.toDocumentList(documents) } });
  } catch (err) {
    handle(res, err);
  }
}

// §CORRECTION — FACTURED SHIPMENTS / PAID INVOICES (2026-09-01) : "Invoice
// date" éditable directement depuis le tableau "Sage Documents" (§1 du
// ticket) — même principe que updateRawMaterial ci-dessus.
async function updateInvoice(req, res) {
  try {
    const { invoice, documents } = await svc.updateInvoice(req.params.id, req.body, actorFrom(req));
    res.json({ success: true, data: { ...dto.toInvoiceResponse(invoice), documents: dto.toDocumentList(documents) } });
  } catch (err) {
    handle(res, err);
  }
}

// "Upload invoice" (multipart, ≥1 fichier) : 1 fichier = 1 facture
// indépendamment lue par OCR (confirmé avec l'utilisateur) — on ne bloque
// pas tout le lot si un seul fichier échoue. Flux JSON historique (aucun
// fichier) : comportement inchangé, réponse `data` reste un objet unique.
async function createInvoice(req, res) {
  try {
    const files = req.files || [];
    if (files.length > 0) {
      const actor = actorFrom(req);
      const results = [];
      const errors = [];
      for (const file of files) {
        try {
          const invoice = await svc.processInvoiceUpload(file, actor);
          results.push(dto.toInvoiceResponse(invoice));
        } catch (err) {
          errors.push({ file: file.originalname, status: err.status || 500, message: err.message || "Erreur inconnue" });
        }
      }
      if (!results.length) {
        return res.status(errors[0]?.status || 500).json({ success: false, message: "Aucune facture n'a pu être créée", errors });
      }
      return res.status(201).json({ success: true, data: results, ...(errors.length ? { errors } : {}) });
    }

    const data = await svc.createInvoice(req.body, actorFrom(req));
    res.status(201).json({ success: true, data: dto.toInvoiceResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function registerPayment(req, res) {
  try {
    const data = await svc.registerPayment(req.params.id, req.body, req.file, actorFrom(req));
    res.status(201).json({ success: true, data: dto.toInvoiceResponse(data) });
  } catch (err) {
    handle(res, err);
  }
}

async function deleteInvoice(req, res) {
  try {
    await svc.deleteInvoice(req.params.id, actorFrom(req));
    res.json({ success: true, message: "Invoice deleted successfully" });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = {
  getDashboard,
  getDashboardMonthly,
  listRawMaterials,
  uploadRawMaterial,
  getRawMaterial,
  updateRawMaterial,
  deleteRawMaterial,
  addRawMaterialDocuments,
  deleteRawMaterialDocument,
  listOtherDocuments,
  uploadOtherDocument,
  renameOtherDocument,
  deleteOtherDocument,
  rawMaterialsImport,
  shipmentsImport,
  facturedShipmentsImport,
  paidInvoicesImport,
  listShipments,
  createShipment,
  getShipment,
  updateShipment,
  deleteShipment,
  listInvoices,
  listPaidInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  registerPayment,
  deleteInvoice,
};
