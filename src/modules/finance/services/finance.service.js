"use strict";

const fs = require("fs");
const path = require("path");
const { Op } = require("sequelize");
const { sequelize } = require("../../../db");
const repo = require("../repositories/finance.repository");
const { sanitizeOriginalName, UPLOAD_DIR } = require("../../../middleware/financeDocumentUpload.middleware");
const logger = require("../../../utils/logger");
const invoiceOcr = require("./invoiceOcr.service");
const invoiceFieldExtraction = require("./invoiceFieldExtraction.service");
const invoiceValidation = require("./invoiceValidation.service");
const deliveryNoteOcr = require("./deliveryNoteOcr.service");
const deliveryNoteFieldExtraction = require("./deliveryNoteFieldExtraction.service");
const deliveryNoteValidation = require("./deliveryNoteValidation.service");
const purchaseOrderFieldExtraction = require("./purchaseOrderFieldExtraction.service");
const purchaseOrderValidation = require("./purchaseOrderValidation.service");

const RAW_MATERIALS_MODULE = "INFLOW_RAW_MATERIALS";
const SHIPMENT_MODULE = "SHIPMENT";
const INVOICE_MODULE = "INVOICE";
const PAYMENT_MODULE = "PAYMENT";

function toPage(filters) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.max(1, parseInt(filters.pageSize, 10) || 50);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function docUrl(file) {
  return `/uploads/finance-documents/${file.filename}`;
}

// ── DASHBOARD (§4) — toujours calculé dynamiquement, jamais de valeur figée ─

async function getDashboard() {
  const [rawMaterialDocuments, shipments, facturedShipments, paidInvoices, invoicedSum, paidSum] = await Promise.all([
    repo.countDocuments({ module: RAW_MATERIALS_MODULE }),
    repo.countShipments(),
    repo.countInvoices(),
    repo.countInvoices({ status: "PAID" }),
    repo.sumInvoiceAmount(),
    repo.sumPaymentAmount(),
  ]);

  const totalInvoicedAmount = Number(invoicedSum) || 0;
  const totalPaidAmount = Number(paidSum) || 0;

  return {
    rawMaterialDocuments,
    shipments,
    facturedShipments,
    paidInvoices,
    totalRawMaterialDocuments: rawMaterialDocuments,
    totalShipments: shipments,
    totalInvoicedAmount,
    totalPaidAmount,
    outstandingAmount: Math.max(0, totalInvoicedAmount - totalPaidAmount),
  };
}

// ── INFLOW OF RAW MATERIALS (§5) ────────────────────────────────────────
// "CORRECTION — EXTRACTION AUTOMATIQUE DES BONS DE COMMANDE" : un Bon de
// Commande uploadé est désormais LU (OCR/texte PDF), pas seulement stocké
// comme fichier brut — même architecture que processInvoiceUpload
// (extraction positionnelle X/Y, validation, sauvegarde atomique).

async function listRawMaterials(filters = {}) {
  const where = {};
  if (filters.search) Object.assign(where, repo.purchaseOrderSearchClause(filters.search));
  const { page, pageSize, limit, offset } = toPage(filters);
  const [data, total] = await Promise.all([
    repo.findPurchaseOrders(where, { limit, offset }),
    repo.countPurchaseOrders(where),
  ]);
  return { data: await attachDocumentsForModule(RAW_MATERIALS_MODULE, data), total, page, pageSize };
}

async function getRawMaterial(id) {
  const order = await repo.findPurchaseOrderById(id);
  if (!order) throw { status: 404, message: "Bon de commande introuvable" };
  const documents = await repo.findDocuments({ module: RAW_MATERIALS_MODULE, entityId: id });
  return { order, documents };
}

// Moyenne des confidences des champs top-level effectivement détectés
// (0-100) — indicateur global, jamais utilisé seul pour décider
// EXTRACTED/NEEDS_REVIEW (voir purchaseOrderValidation.service.js).
function computePurchaseOrderConfidence(extraction) {
  const scores = [];
  const consider = (f) => {
    if (f && f.value !== null && f.value !== undefined) scores.push(f.confidence);
  };
  consider(extraction.orderNumber);
  consider(extraction.orderDate);
  consider(extraction.customer.code);
  consider(extraction.customer.name);
  consider(extraction.customer.address);
  consider(extraction.delivery.address);
  consider(extraction.totalHT);
  for (const it of extraction.items) scores.push(it.confidence || 0);
  if (!scores.length) return 0;
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  return Math.round(avg <= 1 ? avg * 100 : avg);
}

// "Upload" (page Inflow of raw materials) — LIT réellement le document
// (OCR/texte PDF), extrait/normalise/valide les données, puis crée le Bon
// de Commande + ses lignes + le document associé dans UNE transaction
// atomique (jamais de document INFLOW_RAW_MATERIALS sans bon associé, même
// invariant que Shipment/Invoice). 1 fichier = 1 bon de commande.
async function processRawMaterialUpload(file, actor) {
  if (!file) throw { status: 400, message: "Fichier requis" };

  logger.info(`[PURCHASE ORDER] File uploaded (${file.originalname})`);
  logger.info("[PURCHASE ORDER OCR] Text extraction started");

  let doc;
  try {
    doc = await invoiceOcr.extractDocumentText({
      filePath: file.path,
      mimeType: file.mimetype,
      originalName: file.originalname,
    });
  } catch (err) {
    logger.error("[PURCHASE ORDER OCR] Extraction failed:", err.message);
    doc = { pages: [], fullText: "", engine: "none" };
  }

  logger.info("[PURCHASE ORDER OCR] Text extraction completed");

  const ocrFailed = doc.engine === "none" || !doc.fullText || !doc.fullText.trim();

  const extraction = await purchaseOrderFieldExtraction.extractPurchaseOrderFields({
    fullText: doc.fullText,
    filePath: file.path,
    engine: doc.engine,
    pages: doc.pages,
  });

  logger.info(`[PURCHASE ORDER OCR] Order number detected: ${extraction.orderNumber.value ?? "null"}`);
  logger.info(`[PURCHASE ORDER OCR] Customer detected: ${extraction.customer.name.value ?? "null"}`);
  logger.info(`[PURCHASE ORDER OCR] Items detected: ${extraction.items.length}`);
  logger.info(`[PURCHASE ORDER OCR] Total HT detected: ${extraction.totalHT.value ?? "null"}`);

  const { needsReview, reasons } = purchaseOrderValidation.validateExtraction(extraction);
  logger.info(`[PURCHASE ORDER OCR] Validation completed (needsReview=${needsReview}${reasons.length ? `, reasons=${reasons.join(",")}` : ""})`);

  const hasReliableOrderNumber =
    Boolean(extraction.orderNumber.value) && extraction.orderNumber.confidence >= purchaseOrderValidation.CONFIDENCE_THRESHOLD;
  const overallConfidence = computePurchaseOrderConfidence(extraction);
  const status = ocrFailed ? "OCR_FAILED" : needsReview || !hasReliableOrderNumber ? "NEEDS_REVIEW" : "EXTRACTED";

  try {
    let orderId;
    await sequelize.transaction(async (t) => {
      const order = await repo.createPurchaseOrder(
        {
          orderNumber: extraction.orderNumber.value, // jamais généré/inventé — reste null si absent du document
          orderDate: extraction.orderDate.value,
          customerId: null, // jamais résolu automatiquement vers un client existant
          customerCode: extraction.customer.code.value,
          customerName: extraction.customer.name.value,
          customerAddress: extraction.customer.address.value,
          deliveryAddress: extraction.delivery.address.value,
          totalHT: extraction.totalHT.value,
          status,
          ocrConfidence: overallConfidence,
          ocrExtraction: { ...extraction, engine: doc.engine, rawText: doc.fullText, validation: { needsReview, reasons } },
          createdBy: actor.id,
        },
        { transaction: t }
      );
      orderId = order.id;

      if (extraction.items.length) {
        await repo.createPurchaseOrderItems(
          extraction.items.map((it, i) => ({
            purchaseOrderId: order.id,
            sortOrder: i,
            reference: it.reference ?? null,
            designation: it.designation ?? null,
            unit: it.unit ?? null,
            quantity: it.quantity ?? null,
            unitPriceHT: it.unitPriceHT ?? null,
            amountHT: it.amountHT ?? null,
          })),
          { transaction: t }
        );
      }

      const originalName = sanitizeOriginalName(file.originalname);
      await repo.createDocument(
        {
          module: RAW_MATERIALS_MODULE,
          entityId: order.id,
          originalName,
          storedFileName: file.filename,
          fileUrl: docUrl(file),
          mimeType: file.mimetype,
          fileSize: file.size,
          uploadedBy: actor.id,
        },
        { transaction: t }
      );

      await repo.logActivity(
        {
          entityType: "DOCUMENT",
          entityId: order.id,
          userId: actor.id,
          type: "UPLOAD_DOCUMENT",
          message: `Document "${originalName}" déposé (Inflow of raw materials)`,
        },
        { transaction: t }
      );
      await repo.logActivity(
        {
          entityType: "PURCHASE_ORDER",
          entityId: order.id,
          userId: actor.id,
          type: "CREATE_PURCHASE_ORDER",
          message: `Bon de commande "${extraction.orderNumber.value ?? orderId}" créé automatiquement par OCR (${extraction.items.length} ligne(s), confiance=${overallConfidence})`,
        },
        { transaction: t }
      );
    });

    logger.info("[PURCHASE ORDER OCR] Data saved");
    logger.info(`[PURCHASE ORDER OCR] Purchase order saved (id=${orderId}, status=${status})`);
    return getRawMaterial(orderId);
  } catch (err) {
    await fs.promises.unlink(file.path).catch(() => {});
    throw err.status ? err : { status: 500, message: "Échec du traitement du Bon de Commande" };
  }
}

// ── SUPPRESSION (§AJOUTER LA SUPPRESSION DES DOCUMENTS FINANCE) ─────────
// Logique commune aux 3 modules (Purchase Order / Shipment / Invoice) :
// les enfants "forts" (items, payments) sont supprimés par CASCADE au
// niveau BASE (FK onDelete CASCADE — voir les migrations correspondantes),
// jamais recréés ici. Les documents (référence souple entityId, PAS de FK —
// voir FinanceDocument) sont supprimés explicitement, dans la MÊME
// transaction que l'entité parente : soit tout est supprimé, soit rien ne
// l'est (ROLLBACK automatique en cas d'erreur). Les fichiers PHYSIQUES ne
// sont supprimés qu'APRÈS le COMMIT réussi — jamais avant, pour ne jamais
// perdre un fichier si la transaction est finalement annulée.
async function deleteEntityWithDocuments({ entity, module }) {
  const documents = await repo.findDocuments({ module, entityId: entity.id });

  await sequelize.transaction(async (t) => {
    for (const doc of documents) {
      await repo.destroyDocument(doc, { transaction: t });
    }
    await entity.destroy({ transaction: t });
  });

  for (const doc of documents) {
    const filePath = path.join(UPLOAD_DIR, doc.storedFileName);
    try {
      await fs.promises.unlink(filePath);
    } catch (_) {
      // Fichier déjà absent du disque — ne bloque jamais la suppression en base.
    }
  }

  return documents;
}

async function deleteRawMaterial(id, actor) {
  const order = await repo.findPurchaseOrderById(id);
  if (!order) throw { status: 404, message: "Bon de commande introuvable" };

  await deleteEntityWithDocuments({ entity: order, module: RAW_MATERIALS_MODULE });

  await repo.logActivity({
    entityType: "PURCHASE_ORDER",
    entityId: id,
    userId: actor.id,
    type: "DELETE_PURCHASE_ORDER",
    message: `Bon de commande "${order.orderNumber ?? id}" supprimé`,
  });

  return { id };
}

// ── SHIPMENT OF PRODUCTS TO THE CUSTOMERS (§7) ──────────────────────────
//
// "New shipment" simplifié : le formulaire ne collecte plus que des
// documents. IMPORTANT — invariant du nouveau workflow : un document
// "SHIPMENT" ne doit JAMAIS exister sans Shipment associé (contrairement à
// une version précédente de ce modal qui créait des documents orphelins,
// aujourd'hui abandonnée). createShipment() ci-dessous crée donc TOUJOURS
// le Shipment et ses documents ensemble, de façon atomique.

// Référence unique auto-générée (aucun champ Reference dans le formulaire) —
// format SHIP-{année}-{6 chiffres}, jamais dérivée du nom de fichier.
async function generateShipmentReference(transaction) {
  const year = new Date().getFullYear();
  const prefix = `SHIP-${year}-`;
  const count = await repo.countShipments({ reference: { [Op.like]: `${prefix}%` } }, { transaction });
  return `${prefix}${String(count + 1).padStart(6, "0")}`;
}

function buildShipmentWhere(filters = {}) {
  const where = {};
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.status) where.status = filters.status;
  return where;
}

// Attache les documents associés à chaque enregistrement de la page courante
// (un seul SELECT groupé, jamais de N+1) — colonne "Documents" des listes
// Shipments (§7) et Invoices (§8/§9 modifiés), factorisé pour les deux.
async function attachDocumentsForModule(module, records) {
  const ids = records.map((r) => r.id);
  const documents = await repo.findDocumentsByEntityIds(module, ids);
  const byRecord = new Map();
  for (const doc of documents) {
    const list = byRecord.get(doc.entityId) || [];
    list.push(doc);
    byRecord.set(doc.entityId, list);
  }
  return records.map((r) => {
    const plain = r.toJSON();
    plain.documents = byRecord.get(r.id) || [];
    return plain;
  });
}

async function listShipments(filters = {}) {
  const where = buildShipmentWhere(filters);
  if (filters.search) Object.assign(where, repo.shipmentSearchClause(filters.search));
  const { page, pageSize, limit, offset } = toPage(filters);
  const [data, total] = await Promise.all([
    repo.findShipments(where, { limit, offset }),
    repo.countShipments(where),
  ]);
  return { data: await attachDocumentsForModule(SHIPMENT_MODULE, data), total, page, pageSize };
}

// Crée le Shipment ET ses documents dans UNE transaction atomique : soit les
// deux existent, soit ni l'un ni l'autre (jamais de document SHIPMENT sans
// Shipment). En cas d'échec (à n'importe quelle étape), Sequelize annule la
// transaction et les fichiers déjà écrits sur disque par multer AVANT
// l'appel (donc non couverts par le rollback SQL) sont supprimés
// explicitement — aucun fichier orphelin ne doit survivre à une erreur.
// Moyenne des confidences des champs top-level effectivement détectés
// (0-100) — même principe que computeOverallConfidence() pour les factures.
function computeShipmentOverallConfidence(extraction) {
  const scores = [];
  const consider = (f) => {
    if (f && f.value !== null && f.value !== undefined) scores.push(f.confidence);
  };
  consider(extraction.deliveryNumber);
  consider(extraction.deliveryDate);
  consider(extraction.customerPhone);
  consider(extraction.reference);
  consider(extraction.customer.name);
  consider(extraction.customer.taxId);
  consider(extraction.customer.address);
  consider(extraction.customer.governorate);
  consider(extraction.customer.headOfficeAddress);
  consider(extraction.delivery.truckRegistration);
  consider(extraction.delivery.manufacturer);
  consider(extraction.delivery.driverName);
  consider(extraction.delivery.deliveryAddress);
  consider(extraction.total);
  for (const it of extraction.items) scores.push(it.confidence || 0);
  if (!scores.length) return 0;
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  return Math.round(avg <= 1 ? avg * 100 : avg);
}

// "New shipment" (page Customer shipments) — LIT réellement le Bon de
// Livraison (OCR/texte PDF), extrait/normalise/valide les données, puis crée
// le Shipment + ses lignes produit + ses documents dans UNE transaction
// atomique (jamais de document/ligne SHIPMENT sans Shipment). Le modal
// autorise plusieurs fichiers pour UN shipment (décision confirmée
// précédemment pour cet écran, contrairement aux factures) : le PREMIER
// fichier est le document analysé par OCR, tous les fichiers sont attachés
// comme documents du shipment créé.
async function processShipmentUpload(files, actor) {
  if (!files.length) throw { status: 400, message: "Au moins un document est requis" };
  const primaryFile = files[0];

  logger.info(`[DELIVERY] File uploaded (${primaryFile.originalname})`);
  logger.info("[DELIVERY OCR] Text extraction started");

  let doc;
  try {
    doc = await deliveryNoteOcr.extractDeliveryNoteData({
      filePath: primaryFile.path,
      mimeType: primaryFile.mimetype,
      originalName: primaryFile.originalname,
    });
  } catch (err) {
    logger.error("[DELIVERY OCR] Extraction failed:", err.message);
    doc = { pages: [], fullText: "", engine: "none" };
  }

  logger.info("[DELIVERY OCR] Text extraction completed");

  // Aucun texte exploitable du tout (format non-OCR-able, PDF illisible,
  // page blanche...) — pipeline OCR en échec complet, distinct d'une
  // extraction partielle/incertaine (NEEDS_REVIEW) : voir §Gestion des
  // erreurs, "ne jamais considérer un document comme correctement traité
  // si l'extraction a échoué".
  const ocrFailed = doc.engine === "none" || !doc.fullText || !doc.fullText.trim();

  const extraction = await deliveryNoteFieldExtraction.extractDeliveryNoteFields({
    fullText: doc.fullText,
    filePath: primaryFile.path,
    engine: doc.engine,
    pages: doc.pages,
  });

  logger.info(`[DELIVERY OCR] Delivery number: ${extraction.deliveryNumber.value ?? "null"}`);
  logger.info(`[DELIVERY OCR] Customer: ${extraction.customer.name.value ?? "null"}`);
  logger.info(
    `[DELIVERY OCR] Delivery information detected (truck=${extraction.delivery.truckRegistration.value}, driver=${extraction.delivery.driverName.value})`
  );
  logger.info(`[DELIVERY OCR] Items: ${extraction.items.length}`);
  logger.info(`[DELIVERY OCR] Total: ${extraction.total.value ?? "null"}`);

  const { needsReview, reasons } = deliveryNoteValidation.validateExtraction(extraction);
  logger.info(`[DELIVERY OCR] Validation completed (needsReview=${needsReview}${reasons.length ? `, reasons=${reasons.join(",")}` : ""})`);

  const hasReliableDeliveryNumber =
    Boolean(extraction.deliveryNumber.value) && extraction.deliveryNumber.confidence >= deliveryNoteValidation.CONFIDENCE_THRESHOLD;
  const overallConfidence = computeShipmentOverallConfidence(extraction);
  const status = ocrFailed ? "OCR_FAILED" : needsReview || !hasReliableDeliveryNumber ? "NEEDS_REVIEW" : "EXTRACTED";

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let shipmentId;
    try {
      await sequelize.transaction(async (t) => {
        const reference = hasReliableDeliveryNumber ? extraction.deliveryNumber.value : await generateShipmentReference(t);

        const shipment = await repo.createShipment(
          {
            reference,
            customerReference: extraction.reference.value,
            customerId: null, // jamais résolu automatiquement vers un client existant (nom/tél/adresse lus, pas un id)
            customerName: extraction.customer.name.value,
            customerPhone: extraction.customerPhone.value,
            customerAddress: extraction.customer.address.value,
            customerGovernorate: extraction.customer.governorate.value,
            customerTaxId: extraction.customer.taxId.value,
            customerCode: extraction.customer.code.value,
            customerHeadOfficeAddress: extraction.customer.headOfficeAddress.value,
            truckRegistration: extraction.delivery.truckRegistration.value,
            truckManufacturer: extraction.delivery.manufacturer.value,
            driverName: extraction.delivery.driverName.value,
            deliveryAddress: extraction.delivery.deliveryAddress.value,
            shipmentDate: extraction.deliveryDate.value,
            products: [],
            totalQuantity: extraction.total.value,
            totalAmount: 0,
            status,
            ocrConfidence: overallConfidence,
            ocrExtraction: { ...extraction, engine: doc.engine, rawText: doc.fullText, validation: { needsReview, reasons } },
            createdBy: actor.id,
          },
          { transaction: t }
        );
        shipmentId = shipment.id;

        if (extraction.items.length) {
          await repo.createShipmentItems(
            extraction.items.map((it, i) => ({
              shipmentId: shipment.id,
              sortOrder: i,
              reference: it.reference ?? null,
              designation: it.designation ?? null,
              unit: it.unit ?? null,
              diameter: it.diameter ?? null,
              meshSize: it.meshSize ?? null,
              quantity: it.quantity ?? null,
            })),
            { transaction: t }
          );
        }

        for (const file of files) {
          const originalName = sanitizeOriginalName(file.originalname);
          await repo.createDocument(
            {
              module: SHIPMENT_MODULE,
              entityId: shipment.id,
              originalName,
              storedFileName: file.filename,
              fileUrl: docUrl(file),
              mimeType: file.mimetype,
              fileSize: file.size,
              uploadedBy: actor.id,
            },
            { transaction: t }
          );
          await repo.logActivity(
            {
              entityType: "DOCUMENT",
              entityId: shipment.id,
              userId: actor.id,
              type: "UPLOAD_DOCUMENT",
              message: `Document "${originalName}" déposé (Shipment ${reference})`,
            },
            { transaction: t }
          );
        }

        await repo.logActivity(
          {
            entityType: "SHIPMENT",
            entityId: shipment.id,
            userId: actor.id,
            type: "CREATE_SHIPMENT",
            message: `Shipment "${reference}" créé automatiquement par OCR (${extraction.items.length} ligne(s), confiance=${overallConfidence})`,
          },
          { transaction: t }
        );
      });

      logger.info("[DELIVERY OCR] Data saved");
      logger.info(`[DELIVERY OCR] Shipment saved (id=${shipmentId}, status=${status})`);
      logger.info("[DELIVERY] Shipment created successfully");
      const [shipment, documents] = await Promise.all([
        repo.findShipmentById(shipmentId),
        repo.findDocuments({ module: SHIPMENT_MODULE, entityId: shipmentId }),
      ]);
      const plain = shipment.toJSON();
      plain.documents = documents;
      return plain;
    } catch (err) {
      // Course rare sur la référence auto-générée/le numéro BL détecté (deux
      // requêtes concurrentes) → un nouvel essai suffit ; jamais retenté si
      // un numéro de BL fiable avait été détecté (véritable doublon).
      const isAutoReferenceConflict = !hasReliableDeliveryNumber && err?.name === "SequelizeUniqueConstraintError";
      if (isAutoReferenceConflict && attempt < MAX_ATTEMPTS) continue;

      await Promise.all(files.map((f) => fs.promises.unlink(f.path).catch(() => {})));

      if (hasReliableDeliveryNumber && err?.name === "SequelizeUniqueConstraintError") {
        throw { status: 409, message: `Un shipment avec le numéro "${extraction.deliveryNumber.value}" existe déjà` };
      }
      throw err.status ? err : { status: 500, message: "Échec du traitement du Bon de Livraison" };
    }
  }
}

async function createShipment(body, actor, files = []) {
  return processShipmentUpload(files, actor);
}

async function getShipment(id) {
  const shipment = await repo.findShipmentById(id);
  if (!shipment) throw { status: 404, message: "Shipment introuvable" };
  const documents = await repo.findDocuments({ module: SHIPMENT_MODULE, entityId: id });
  return { shipment, documents };
}

async function updateShipment(id, body, actor) {
  const shipment = await repo.findShipmentById(id);
  if (!shipment) throw { status: 404, message: "Shipment introuvable" };

  await repo.updateShipment(shipment, body);

  await repo.logActivity({
    entityType: "SHIPMENT",
    entityId: id,
    userId: actor.id,
    type: "UPDATE_SHIPMENT",
    message: `Shipment "${shipment.reference}" modifié`,
  });

  return repo.findShipmentById(id);
}

// Supprimer un Shipment ne supprime JAMAIS les Invoices qui en dérivent —
// leur `shipmentId` est SET NULL par la FK (voir migration finance_invoices,
// onDelete: "SET NULL") : une facture reste valide même si son bon de
// livraison d'origine est ensuite supprimé.
async function deleteShipment(id, actor) {
  const shipment = await repo.findShipmentById(id);
  if (!shipment) throw { status: 404, message: "Shipment introuvable" };

  await deleteEntityWithDocuments({ entity: shipment, module: SHIPMENT_MODULE });

  await repo.logActivity({
    entityType: "SHIPMENT",
    entityId: id,
    userId: actor.id,
    type: "DELETE_SHIPMENT",
    message: `Shipment "${shipment.reference}" supprimé`,
  });

  return { id };
}

// ── FACTURED SHIPMENTS / PAID FACTURES (§8-9) ───────────────────────────
//
// "Upload invoice" simplifié : comme pour "New shipment", un document
// INVOICE ne doit jamais exister sans Invoice associée — createInvoice()
// crée les deux ensemble, de façon atomique, quand des fichiers sont fournis.

// Référence unique auto-générée (aucun champ Invoice number dans le modal
// "Upload invoice") — format INV-{année}-{6 chiffres}, jamais dérivée du nom
// de fichier. Le flux JSON historique (facture créée depuis un shipment,
// avec un invoiceNumber explicite) continue de fonctionner tel quel.
async function generateInvoiceNumber(transaction) {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const count = await repo.countInvoices({ invoiceNumber: { [Op.like]: `${prefix}%` } }, { transaction });
  return `${prefix}${String(count + 1).padStart(6, "0")}`;
}

function buildInvoiceWhere(filters = {}) {
  const where = {};
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.status) where.status = filters.status;
  if (filters.startDate || filters.endDate) {
    where.invoiceDate = {};
    if (filters.startDate) where.invoiceDate[Op.gte] = filters.startDate;
    if (filters.endDate) where.invoiceDate[Op.lte] = filters.endDate;
  }
  return where;
}

async function listInvoices(filters = {}) {
  const where = buildInvoiceWhere(filters);
  if (filters.search) Object.assign(where, repo.invoiceSearchClause(filters.search));
  const { page, pageSize, limit, offset } = toPage(filters);
  const [data, total] = await Promise.all([
    repo.findInvoices(where, { limit, offset }),
    repo.countInvoices(where),
  ]);
  return { data: await attachDocumentsForModule(INVOICE_MODULE, data), total, page, pageSize };
}

// "Paid factures" (§9) — mêmes filtres que Factured Shipments, statut PAID
// systématiquement imposé côté serveur (jamais laissé au client).
function listPaidInvoices(filters = {}) {
  return listInvoices({ ...filters, status: "PAID" });
}

// Le document justificatif d'un paiement (Chèque/Traite) est une référence
// souple FinanceDocument (module "PAYMENT", entityId = paiement), jamais
// une association Sequelize directe (même convention que les 3 autres
// modules) — attaché ici en un seul SELECT groupé, jamais de N+1.
async function attachPaymentDocuments(invoicePlain) {
  const paymentIds = (invoicePlain.payments || []).map((p) => p.id);
  if (!paymentIds.length) return invoicePlain;
  const paymentDocuments = await repo.findDocumentsByEntityIds(PAYMENT_MODULE, paymentIds);
  const byPayment = new Map();
  for (const d of paymentDocuments) {
    const list = byPayment.get(d.entityId) || [];
    list.push(d);
    byPayment.set(d.entityId, list);
  }
  invoicePlain.payments = invoicePlain.payments.map((p) => ({ ...p, documents: byPayment.get(p.id) || [] }));
  return invoicePlain;
}

async function getInvoice(id) {
  const invoice = await repo.findInvoiceById(id);
  if (!invoice) throw { status: 404, message: "Facture introuvable" };
  const documents = await repo.findDocuments({ module: INVOICE_MODULE, entityId: id });
  const plain = await attachPaymentDocuments(invoice.toJSON());
  return { invoice: plain, documents };
}

// Supprime la facture, ses lignes (finance_invoice_items) ET ses paiements
// (finance_payments) — les deux sont en CASCADE au niveau BASE (voir
// migrations correspondantes) — puis ses documents/fichiers associés. Ne
// touche jamais au Shipment d'origine (relation dans l'autre sens).
async function deleteInvoice(id, actor) {
  const invoice = await repo.findInvoiceById(id);
  if (!invoice) throw { status: 404, message: "Facture introuvable" };

  await deleteEntityWithDocuments({ entity: invoice, module: INVOICE_MODULE });

  await repo.logActivity({
    entityType: "INVOICE",
    entityId: id,
    userId: actor.id,
    type: "DELETE_INVOICE",
    message: `Facture "${invoice.invoiceNumber}" supprimée`,
  });

  return { id };
}

// Deux flux coexistent ici :
//  1. Historique (JSON, sans fichier) — facture créée depuis un shipment,
//     customerId/invoiceDate/amount requis, invoiceNumber fourni. Confirmé
//     nécessaire avec l'utilisateur : sans lui, Factured Shipments et Paid
//     Factures resteraient en permanence vides. Comportement INCHANGÉ.
//  2. "Upload invoice" simplifié (multipart, ≥1 fichier) — la facture est
//     créée AUTOMATIQUEMENT à partir des documents (invoiceNumber
//     auto-généré, tous les autres champs optionnels/à 0), en une
//     transaction atomique — jamais de document INVOICE sans Invoice.
// Flux historique JSON (facture créée depuis un shipment) — customerId/
// invoiceDate/amount requis, invoiceNumber fourni. Comportement INCHANGÉ ;
// le flux "Upload invoice" (fichiers, OCR) est entièrement pris en charge
// par processInvoiceUpload() ci-dessous, jamais par cette fonction.
async function createInvoice(body, actor) {
  if (!body.customerId || !body.invoiceDate || body.amount == null) {
    throw { status: 400, message: "customerId, invoiceDate et amount sont requis" };
  }

  const hasExplicitInvoiceNumber = Boolean(body.invoiceNumber && String(body.invoiceNumber).trim());
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let invoiceId;
    try {
      await sequelize.transaction(async (t) => {
        const invoiceNumber = hasExplicitInvoiceNumber ? String(body.invoiceNumber).trim() : await generateInvoiceNumber(t);
        const amount = Number(body.amount) || 0;
        const tax = Number(body.tax) || 0;
        const total = body.total != null ? Number(body.total) : amount + tax;

        const invoice = await repo.createInvoice(
          {
            invoiceNumber,
            shipmentId: body.shipmentId || null,
            customerId: body.customerId || null,
            invoiceDate: body.invoiceDate || null,
            amount,
            tax,
            total,
            createdBy: actor.id,
          },
          { transaction: t }
        );
        invoiceId = invoice.id;

        await repo.logActivity(
          {
            entityType: "INVOICE",
            entityId: invoice.id,
            userId: actor.id,
            type: "CREATE_INVOICE",
            message: `Facture "${invoiceNumber}" créée`,
          },
          { transaction: t }
        );
      });

      const invoice = await repo.findInvoiceById(invoiceId);
      return invoice.toJSON();
    } catch (err) {
      const isAutoNumberConflict = !hasExplicitInvoiceNumber && err?.name === "SequelizeUniqueConstraintError";
      if (isAutoNumberConflict && attempt < MAX_ATTEMPTS) continue;
      throw err.status ? err : { status: 500, message: "Échec de la création de la facture" };
    }
  }
}

// Moyenne des confidences des champs top-level effectivement détectés
// (0-100) — indicateur global affiché à l'utilisateur, jamais utilisé seul
// pour décider ISSUED/NEEDS_REVIEW (voir invoiceValidation.service.js pour
// les règles réelles).
function computeOverallConfidence(extraction) {
  const scores = [];
  const consider = (f) => {
    if (f && f.value !== null && f.value !== undefined) scores.push(f.confidence);
  };
  consider(extraction.invoiceNumber);
  consider(extraction.invoiceDate);
  consider(extraction.reference);
  consider(extraction.customer.name);
  consider(extraction.customer.phone);
  consider(extraction.customer.address);
  consider(extraction.customer.governorate);
  consider(extraction.customer.taxId);
  consider(extraction.totals.subtotalHT);
  consider(extraction.totals.totalTax);
  consider(extraction.totals.totalTTC);
  for (const it of extraction.items) scores.push(it.confidence || 0);
  if (!scores.length) return 0;
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  return Math.round(avg <= 1 ? avg * 100 : avg);
}

// "Upload invoice" (page Factured shipments) — LIT réellement le document
// (OCR/texte PDF), extrait/normalise/valide les données, puis crée la
// facture + ses lignes + le document associé dans UNE transaction atomique
// (jamais de document INVOICE sans Invoice, même invariant que Shipment).
// 1 fichier = 1 facture indépendamment traitée (décision confirmée avec
// l'utilisateur) — appelée une fois par fichier depuis le controller.
async function processInvoiceUpload(file, actor) {
  logger.info(`[INVOICE] File uploaded (${file.originalname})`);
  logger.info("[INVOICE OCR] Text extraction started");

  let doc;
  try {
    doc = await invoiceOcr.extractDocumentText({
      filePath: file.path,
      mimeType: file.mimetype,
      originalName: file.originalname,
    });
  } catch (err) {
    logger.error("[INVOICE OCR] Extraction failed:", err.message);
    doc = { pages: [], fullText: "", engine: "none" };
  }

  logger.info("[INVOICE OCR] Text extraction completed");

  // Aucun texte exploitable du tout (format non-OCR-able, PDF illisible...)
  // — pipeline OCR en échec complet, distinct d'une extraction
  // partielle/incertaine (NEEDS_REVIEW).
  const ocrFailed = doc.engine === "none" || !doc.fullText || !doc.fullText.trim();

  const extraction = await invoiceFieldExtraction.extractInvoiceFields({
    fullText: doc.fullText,
    filePath: file.path,
    engine: doc.engine,
    pages: doc.pages,
  });

  logger.info(`[INVOICE OCR] Invoice number detected: ${extraction.invoiceNumber.value ?? "null"}`);
  logger.info(`[INVOICE OCR] Invoice date detected: ${extraction.invoiceDate.value ?? "null"}`);
  logger.info(`[INVOICE OCR] Customer detected: ${extraction.customer.name.value ?? "null"}`);
  logger.info(`[INVOICE OCR] Tax ID detected: ${extraction.customer.taxId.value ?? "null"}`);
  logger.info(`[INVOICE OCR] Items detected: ${extraction.items.length}`);
  logger.info(
    `[INVOICE OCR] Total extraction completed (subtotalHT=${extraction.totals.subtotalHT.value}, totalTax=${extraction.totals.totalTax.value}, totalTTC=${extraction.totals.totalTTC.value})`
  );

  const { needsReview, reasons } = invoiceValidation.validateExtraction(extraction);
  logger.info(`[INVOICE OCR] Validation completed (needsReview=${needsReview}${reasons.length ? `, reasons=${reasons.join(",")}` : ""})`);

  const hasReliableInvoiceNumber =
    Boolean(extraction.invoiceNumber.value) && extraction.invoiceNumber.confidence >= invoiceValidation.CONFIDENCE_THRESHOLD;
  const overallConfidence = computeOverallConfidence(extraction);
  const status = ocrFailed ? "OCR_FAILED" : needsReview || !hasReliableInvoiceNumber ? "NEEDS_REVIEW" : "EXTRACTED";

  const amount = extraction.totals.subtotalHT.value;
  const tax = extraction.totals.totalTax.value;
  const total = extraction.totals.totalTTC.value != null ? extraction.totals.totalTTC.value : amount != null && tax != null ? amount + tax : null;

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let invoiceId;
    try {
      await sequelize.transaction(async (t) => {
        const invoiceNumber = hasReliableInvoiceNumber ? extraction.invoiceNumber.value : await generateInvoiceNumber(t);

        const invoice = await repo.createInvoice(
          {
            invoiceNumber,
            reference: extraction.reference.value,
            customerId: null, // jamais résolu automatiquement vers un client existant (nom/tél/adresse lus, pas un id)
            customerName: extraction.customer.name.value,
            customerPhone: extraction.customer.phone.value,
            customerAddress: extraction.customer.address.value,
            customerGovernorate: extraction.customer.governorate.value,
            customerTaxId: extraction.customer.taxId.value,
            customerCode: extraction.customer.code.value,
            invoiceDate: extraction.invoiceDate.value,
            amount: amount ?? 0,
            tax: tax ?? 0,
            total: total ?? 0,
            downPayment: extraction.totals.downPayment?.value ?? null,
            netToPay: extraction.totals.netToPay?.value ?? null,
            paymentCondition: extraction.payment?.condition?.value ?? null,
            paymentDate: extraction.payment?.date?.value ?? null,
            paymentMethod: extraction.payment?.method?.value ?? null,
            amountInWords: extraction.amountInWords?.value ?? null,
            status,
            ocrConfidence: overallConfidence,
            ocrExtraction: { ...extraction, engine: doc.engine, rawText: doc.fullText, validation: { needsReview, reasons } },
            createdBy: actor.id,
          },
          { transaction: t }
        );
        invoiceId = invoice.id;

        if (extraction.items.length) {
          await repo.createInvoiceItems(
            extraction.items.map((it, i) => ({
              invoiceId: invoice.id,
              sortOrder: i,
              reference: it.reference ?? null,
              designation: it.designation ?? null,
              unit: it.unit ?? null,
              diameter: it.diameter ?? null,
              meshSize: it.meshSize ?? null,
              quantity: it.quantity ?? null,
              unitPriceHT: it.unitPriceHT ?? null,
              rms: it.rms ?? null,
              amountHT: it.amountHT ?? null,
              tax1: it.tax1 ?? null,
              tax2: it.tax2 ?? null,
            })),
            { transaction: t }
          );
        }

        if (extraction.taxes && extraction.taxes.length) {
          await repo.createInvoiceTaxes(
            extraction.taxes.map((tx, i) => ({
              invoiceId: invoice.id,
              sortOrder: i,
              code: tx.code ?? null,
              base: tx.base ?? null,
              rate: tx.rate ?? null,
              amount: tx.amount ?? null,
            })),
            { transaction: t }
          );
        }

        const originalName = sanitizeOriginalName(file.originalname);
        await repo.createDocument(
          {
            module: INVOICE_MODULE,
            entityId: invoice.id,
            originalName,
            storedFileName: file.filename,
            fileUrl: docUrl(file),
            mimeType: file.mimetype,
            fileSize: file.size,
            uploadedBy: actor.id,
          },
          { transaction: t }
        );

        await repo.logActivity(
          {
            entityType: "DOCUMENT",
            entityId: invoice.id,
            userId: actor.id,
            type: "UPLOAD_DOCUMENT",
            message: `Document "${originalName}" déposé (Invoice ${invoiceNumber})`,
          },
          { transaction: t }
        );
        await repo.logActivity(
          {
            entityType: "INVOICE",
            entityId: invoice.id,
            userId: actor.id,
            type: "CREATE_INVOICE",
            message: `Facture "${invoiceNumber}" créée automatiquement par OCR (${extraction.items.length} ligne(s), confiance=${overallConfidence})`,
          },
          { transaction: t }
        );
      });

      logger.info("[INVOICE OCR] Data saved");
      logger.info(`[INVOICE OCR] Invoice saved (id=${invoiceId}, status=${status})`);
      logger.info("[INVOICE] Invoice created successfully");
      const [invoice, documents] = await Promise.all([
        repo.findInvoiceById(invoiceId),
        repo.findDocuments({ module: INVOICE_MODULE, entityId: invoiceId }),
      ]);
      const plain = invoice.toJSON();
      plain.documents = documents;
      return plain;
    } catch (err) {
      const isAutoNumberConflict = !hasReliableInvoiceNumber && err?.name === "SequelizeUniqueConstraintError";
      if (isAutoNumberConflict && attempt < MAX_ATTEMPTS) continue;

      await fs.promises.unlink(file.path).catch(() => {});

      if (hasReliableInvoiceNumber && err?.name === "SequelizeUniqueConstraintError") {
        throw { status: 409, message: `Une facture avec le numéro "${extraction.invoiceNumber.value}" existe déjà` };
      }
      throw err.status ? err : { status: 500, message: "Échec du traitement de la facture" };
    }
  }
}

// Champs spécifiques à chaque mode de règlement — mis à NULL pour tous les
// modes qui ne les nécessitent pas, quoi que le client ait pu envoyer
// (§COMPORTEMENT SELON PAYMENT METHOD : "Les champs spécifiques doivent
// être NULL pour les méthodes qui ne les nécessitent pas").
const PAYMENT_METHOD_FIELDS = {
  "Chèque": ["chequeNumber", "bankName", "chequeDate"],
  Traite: ["billOfExchangeNumber", "bankName", "dueDate"],
};
const ALL_METHOD_SPECIFIC_FIELDS = ["chequeNumber", "bankName", "chequeDate", "billOfExchangeNumber", "dueDate"];

// Idem — confirmé nécessaire avec l'utilisateur. Recalcule le statut de la
// facture (ISSUED → PARTIALLY_PAID → PAID) à partir de la somme réelle des
// paiements enregistrés, jamais fixé manuellement par le client. Le
// document justificatif (Chèque/Traite) est enregistré et associé au
// paiement dans la MÊME transaction que le paiement lui-même.
async function registerPayment(invoiceId, body, file, actor) {
  const invoice = await repo.findInvoiceById(invoiceId);
  if (!invoice) throw { status: 404, message: "Facture introuvable" };

  const allowedFields = new Set(PAYMENT_METHOD_FIELDS[body.method] || []);
  const paymentData = { invoiceId, amount: body.amount, paidDate: body.paidDate, method: body.method, reference: body.reference || null };
  for (const f of ALL_METHOD_SPECIFIC_FIELDS) paymentData[f] = allowedFields.has(f) ? body[f] || null : null;

  let payment;
  try {
    await sequelize.transaction(async (t) => {
      payment = await repo.createPayment({ ...paymentData, registeredBy: actor.id }, { transaction: t });

      if (file) {
        const originalName = sanitizeOriginalName(file.originalname);
        await repo.createDocument(
          {
            module: PAYMENT_MODULE,
            entityId: payment.id,
            originalName,
            storedFileName: file.filename,
            fileUrl: docUrl(file),
            mimeType: file.mimetype,
            fileSize: file.size,
            uploadedBy: actor.id,
          },
          { transaction: t }
        );
        await repo.logActivity(
          {
            entityType: "DOCUMENT",
            entityId: payment.id,
            userId: actor.id,
            type: "UPLOAD_DOCUMENT",
            message: `Document "${originalName}" déposé (Payment ${body.method})`,
          },
          { transaction: t }
        );
      }

      const totalPaid = Number(await repo.sumPaymentAmountForInvoice(invoiceId, { transaction: t })) || 0;
      const total = Number(invoice.total) || 0;
      let status = invoice.status === "CANCELLED" ? "CANCELLED" : "ISSUED";
      if (total > 0 && totalPaid >= total) status = "PAID";
      else if (totalPaid > 0) status = "PARTIALLY_PAID";
      await repo.updateInvoice(invoice, { status }, { transaction: t });

      await repo.logActivity(
        {
          entityType: "PAYMENT",
          entityId: invoice.id,
          userId: actor.id,
          type: "REGISTER_PAYMENT",
          message: `Paiement de ${body.amount} (${body.method}) enregistré pour la facture "${invoice.invoiceNumber}"`,
        },
        { transaction: t }
      );
    });
  } catch (err) {
    if (file) await fs.promises.unlink(file.path).catch(() => {});
    throw err.status ? err : { status: 500, message: "Échec de l'enregistrement du paiement" };
  }

  const [updated, documents] = await Promise.all([
    repo.findInvoiceById(invoiceId),
    repo.findDocuments({ module: INVOICE_MODULE, entityId: invoiceId }),
  ]);
  const plain = await attachPaymentDocuments(updated.toJSON());
  plain.documents = documents;
  return plain;
}

module.exports = {
  getDashboard,
  listRawMaterials,
  processRawMaterialUpload,
  getRawMaterial,
  deleteRawMaterial,
  listShipments,
  createShipment,
  processShipmentUpload,
  getShipment,
  updateShipment,
  deleteShipment,
  listInvoices,
  listPaidInvoices,
  getInvoice,
  createInvoice,
  processInvoiceUpload,
  registerPayment,
  deleteInvoice,
};
