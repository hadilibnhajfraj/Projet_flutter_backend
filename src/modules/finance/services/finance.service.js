"use strict";

const fs = require("fs");
const path = require("path");
const { Op } = require("sequelize");
const { sequelize } = require("../../../db");
const User = require("../../../models/User");
const { normalizeUnitAndDiameter } = require("./invoiceNormalization.service");
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
const OTHER_MODULE = "OTHER";

function toPage(filters) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.max(1, parseInt(filters.pageSize, 10) || 50);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function docUrl(file) {
  return `/uploads/finance-documents/${file.filename}`;
}

// ── DASHBOARD (§MODIFICATION — DASHBOARD FINANCE PROFESSIONNEL) — toujours
// calculé dynamiquement (COUNT/SUM/GROUP BY côté serveur, §16-17), jamais de
// valeur figée ni recalculée côté client.
//
// Filtres optionnels (§11) :
// - startDate/endDate : plage de dates (sur orderDate/shipmentDate/
//   invoiceDate/paidDate selon l'entité).
// - customer : texte libre sur `customerName` — la plupart des
//   enregistrements OCR n'ont PAS de customerId résolu ("jamais résolu
//   automatiquement vers un client existant", voir processInvoiceUpload/
//   processShipmentUpload/processRawMaterialUpload plus bas), donc filtrer
//   sur le customerId FK laisserait le filtre systématiquement vide ; on
//   filtre sur le nom réellement extrait, seule donnée fiable et présente.
// - paymentMethod : Invoices/Paid Invoices uniquement (Traite/Chèque/
//   Virement/Versement) — seul contexte où ce champ a un sens.
function dashboardDateRange(field, filters) {
  if (!filters.startDate && !filters.endDate) return {};
  const range = {};
  if (filters.startDate) range[Op.gte] = filters.startDate;
  if (filters.endDate) range[Op.lte] = filters.endDate;
  return { [field]: range };
}

function dashboardCustomerFilter(filters) {
  if (!filters.customer) return {};
  return { customerName: { [Op.iLike]: `%${filters.customer}%` } };
}

function sevenDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d;
}

async function getDashboard(filters = {}) {
  const poWhere = { ...dashboardDateRange("orderDate", filters), ...dashboardCustomerFilter(filters) };
  const shipmentWhere = { ...dashboardDateRange("shipmentDate", filters), ...dashboardCustomerFilter(filters) };
  const invoiceWhere = { ...dashboardDateRange("invoiceDate", filters), ...dashboardCustomerFilter(filters) };
  if (filters.paymentMethod) invoiceWhere.paymentMethod = filters.paymentMethod;
  const paidInvoiceWhere = { ...invoiceWhere, status: "PAID" };
  const unpaidInvoiceWhere = { ...invoiceWhere, status: { [Op.in]: ["ISSUED", "PARTIALLY_PAID"] } };
  const paymentWhere = dashboardDateRange("paidDate", filters);
  const since = sevenDaysAgo();

  const [
    purchaseOrders,
    customerShipments,
    invoices,
    paidInvoices,
    unpaidInvoices,
    totalPurchasesSum,
    totalInvoicedSum,
    totalPaidSum,
    newPurchaseOrdersThisWeek,
    newShipmentsThisWeek,
    recentDocumentsCount,
  ] = await Promise.all([
    repo.countPurchaseOrders(poWhere),
    repo.countShipments(shipmentWhere),
    repo.countInvoices(invoiceWhere),
    repo.countInvoices(paidInvoiceWhere),
    repo.countInvoices(unpaidInvoiceWhere),
    repo.sumPurchaseOrderAmount(poWhere),
    repo.sumInvoiceAmount(invoiceWhere),
    repo.sumPaymentAmount(paymentWhere),
    repo.countPurchaseOrders({ createdAt: { [Op.gte]: since } }),
    repo.countShipments({ createdAt: { [Op.gte]: since } }),
    repo.countDocuments({ createdAt: { [Op.gte]: since } }),
  ]);

  const totalPurchases = Number(totalPurchasesSum) || 0;
  const totalInvoiced = Number(totalInvoicedSum) || 0;
  const totalPaid = Number(totalPaidSum) || 0;

  return {
    purchaseOrders,
    customerShipments,
    invoices,
    paidInvoices,
    totalPurchases,
    totalInvoiced,
    totalPaid,
    outstanding: Math.max(0, totalInvoiced - totalPaid),
    // Finance Alerts (§10) — uniquement des informations réellement
    // disponibles en base, jamais un texte statique.
    alerts: {
      unpaidInvoices,
      newPurchaseOrdersThisWeek,
      newShipmentsThisWeek,
      recentDocumentsCount,
    },
  };
}

// "Financial Overview" (§5) — Purchase Orders/Invoices/Paid Invoices par
// mois (montants, pas des comptes — "comprendre l'évolution des montants").
// Agrégation SQL (GROUP BY date_trunc), jamais côté client. Repli sur les 8
// derniers mois (jan→août façon exemple du ticket) si aucune plage fournie ;
// les mois sans donnée valent 0 (jamais une valeur inventée — 0 signifie
// "rien ce mois-là", pas "non calculé").
async function getDashboardMonthly(filters = {}) {
  const end = filters.endDate ? new Date(filters.endDate) : new Date();
  const start = filters.startDate ? new Date(filters.startDate) : new Date(end.getFullYear(), end.getMonth() - 7, 1);

  const customerWhere = dashboardCustomerFilter(filters);
  const invoiceExtra = { ...customerWhere };
  if (filters.paymentMethod) invoiceExtra.paymentMethod = filters.paymentMethod;

  const [poRows, invoiceRows, paidRows] = await Promise.all([
    repo.sumPurchaseOrdersByMonth({ start, end, extra: customerWhere }),
    repo.sumInvoicesByMonth({ start, end, extra: invoiceExtra }),
    repo.sumPaymentsByMonth({ start, end }),
  ]);

  const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const toMap = (rows) => new Map(rows.map((r) => [monthKey(new Date(r.month)), Number(r.total) || 0]));
  const poMap = toMap(poRows);
  const invMap = toMap(invoiceRows);
  const paidMap = toMap(paidRows);

  const months = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endCursor = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor <= endCursor) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    months.push({
      month: key,
      purchaseOrders: poMap.get(key) || 0,
      invoices: invMap.get(key) || 0,
      paidInvoices: paidMap.get(key) || 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
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

// §MODIFICATION — INFLOW RAW MATERIALS : "Order date" éditable directement
// depuis le tableau — corrige une date que l'OCR n'a pas trouvée ou a mal
// lue (§3 du ticket), sans jamais re-déclencher d'OCR ni toucher aux autres
// champs déjà extraits (numéro, client, lignes...). `body.orderDate` est
// déjà validé "AAAA-MM-JJ" par validateUpdatePurchaseOrder (voir
// finance.validator.js — jamais fait confiance à la seule validation
// Flutter, §4/§12) avant d'arriver ici.
async function updateRawMaterial(id, body, actor) {
  const order = await repo.findPurchaseOrderById(id);
  if (!order) throw { status: 404, message: "Bon de commande introuvable" };

  await repo.updatePurchaseOrder(order, { orderDate: body.orderDate });

  await repo.logActivity({
    entityType: "PURCHASE_ORDER",
    entityId: id,
    userId: actor.id,
    type: "UPDATE_PURCHASE_ORDER_ORDER_DATE",
    message: `Order date mise à jour ("${body.orderDate}") pour le bon de commande "${order.orderNumber ?? id}"`,
  });

  return getRawMaterial(id);
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

// Identifiant métier "PO #" (§IDENTIFICATION DES DIFFÉRENTS PURCHASE
// ORDERS) — format "PO-00001", jamais lié à l'année (contrairement à
// generateInvoiceNumber ci-dessous) : un seul compteur global, toujours
// croissant. Généré UNE SEULE FOIS par Purchase Order (jamais par ligne
// produit) — voir l'unique appel dans processRawMaterialUpload.
async function generatePoNumber(transaction) {
  const prefix = "PO-";
  const count = await repo.countPurchaseOrders({ poNumber: { [Op.like]: `${prefix}%` } }, { transaction });
  return `${prefix}${String(count + 1).padStart(5, "0")}`;
}

// "Upload" (page Inflow of raw materials) — LIT réellement le document
// (OCR/texte PDF), extrait/normalise/valide les données, puis crée le Bon
// de Commande + ses lignes + le document associé dans UNE transaction
// atomique (jamais de document INFLOW_RAW_MATERIALS sans bon associé, même
// invariant que Shipment/Invoice). 1 fichier = 1 bon de commande = 1 PO #.
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
      const poNumber = await generatePoNumber(t);
      const order = await repo.createPurchaseOrder(
        {
          poNumber,
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

// §MODIFICATION — SCAN DOCUMENTS (INCLUDE IMPORT) : PLUSIEURS DOCUMENTS PAR
// LIGNE (2026-09-01) — ajoute N document(s) supplémentaire(s) à UN bon de
// commande déjà EXISTANT (jamais une nouvelle ligne métier, contrairement à
// processRawMaterialUpload ci-dessus qui, lui, crée toujours un nouveau PO) :
// aucune ré-extraction OCR, aucun champ du bon de commande touché. Même
// boucle "1 FinanceDocument par fichier" que processShipmentUpload
// (attache-tous-les-fichiers-à-une-seule-entité), adaptée à une entité déjà
// existante plutôt qu'à une entité fraîchement créée.
async function addRawMaterialDocuments(id, files, actor) {
  if (!files || !files.length) throw { status: 400, message: "Au moins un fichier est requis" };
  const order = await repo.findPurchaseOrderById(id);
  if (!order) throw { status: 404, message: "Bon de commande introuvable" };

  await sequelize.transaction(async (t) => {
    for (const file of files) {
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
          message: `Document "${originalName}" ajouté au bon de commande "${order.orderNumber ?? order.id}"`,
        },
        { transaction: t }
      );
    }
  });

  return getRawMaterial(id);
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

// §MODIFICATION — SCAN DOCUMENTS (INCLUDE IMPORT) : PLUSIEURS DOCUMENTS PAR
// LIGNE (2026-09-01, §9 du ticket) — supprime UN SEUL document d'un bon de
// commande, jamais le bon de commande entier (voir deleteRawMaterial
// ci-dessus pour ce cas-là, inchangé) : les autres documents de la même
// ligne ne sont jamais touchés. Même transaction/suppression physique que
// deleteImportDocument plus bas, mais vérifie ICI en plus que le document
// appartient réellement au bon de commande demandé (`entityId === orderId`)
// — nécessaire ici car ce document est rattaché à une vraie entité métier
// (contrairement à un document "Import" autonome, où seul le module compte).
async function deleteRawMaterialDocument(orderId, docId, actor) {
  const order = await repo.findPurchaseOrderById(orderId);
  if (!order) throw { status: 404, message: "Bon de commande introuvable" };

  const document = await repo.findDocumentById(docId);
  if (!document || document.module !== RAW_MATERIALS_MODULE || document.entityId !== orderId) {
    throw { status: 404, message: "Document introuvable" };
  }

  const originalName = document.displayName ?? document.originalName;
  await sequelize.transaction(async (t) => {
    await repo.destroyDocument(document, { transaction: t });
  });

  const filePath = path.join(UPLOAD_DIR, document.storedFileName);
  try {
    await fs.promises.unlink(filePath);
  } catch (_) {
    // Fichier déjà absent du disque — ne bloque jamais la suppression en base.
  }

  await repo.logActivity({
    entityType: "DOCUMENT",
    entityId: orderId,
    userId: actor.id,
    type: "DELETE_DOCUMENT",
    message: `Document "${originalName}" supprimé du bon de commande "${order.orderNumber ?? orderId}"`,
  });

  return getRawMaterial(orderId);
}

// ── FINANCE > OTHER (§MODIFICATION — SCAN SIMPLE DE DOCUMENTS) ─────────────
// Stockage documentaire PUR — explicitement AUCUN OCR/IA/extraction/mapping/
// création automatique de Purchase Order/Shipment/Invoice (§1, §14).
// Pipeline volontairement à 3 étapes, jamais plus :
//   Upload → Save file (multer, déjà fait en amont) → Save metadata (ici).
// Réutilise le système FinanceDocument existant (§13) — `module: "OTHER"`,
// `entityId` toujours NULL (document autonome, non rattaché à une autre
// entité Finance), rien de nouveau créé côté stockage/DB hormis la colonne
// `displayName` (migration dédiée).
//
// §MODIFICATION CRM — SOUS-MENU IMPORT SUR CHAQUE MENU FINANCE : les 4
// fonctions ci-dessous (list/upload/rename/delete) sont désormais
// paramétrées par `module` au lieu du seul OTHER_MODULE en dur — même
// pipeline en 3 étapes, mêmes garanties (AUCUN OCR, entityId toujours NULL),
// réutilisées TELLES QUELLES pour le nouveau sous-menu "Import" des 4 autres
// pages Finance (Inflow of raw materials/Shipment/Factured shipments/Paid
// factures) — voir listImportDocuments/uploadImportDocument/
// renameImportDocument/deleteImportDocument ci-dessous, jamais une seconde
// implémentation d'upload. listOtherDocuments/uploadOtherDocument/
// renameOtherDocument/deleteOtherDocument restent exportées à l'identique
// (simples enveloppes figées sur OTHER_MODULE) — la route/le comportement
// "Finance > Other" existants ne changent pas d'un octet.
// PAID_INVOICE (Paid factures) n'a pas de constante dédiée ailleurs dans ce
// fichier — Paid factures partage la table finance_invoices (INVOICE_MODULE)
// avec Factured shipments, distinguées uniquement par un filtre côté
// frontend (voir migration 20260827000100 pour l'explication complète).
const PAID_INVOICE_IMPORT_MODULE = "PAID_INVOICE";
const IMPORT_MODULES = [RAW_MATERIALS_MODULE, SHIPMENT_MODULE, INVOICE_MODULE, PAID_INVOICE_IMPORT_MODULE, OTHER_MODULE];

function assertValidImportModule(module) {
  if (!IMPORT_MODULES.includes(module)) throw { status: 400, message: "Module d'import invalide" };
}

function sanitizeDisplayName(name) {
  const base = String(name ?? "")
    .replace(/[\\/]/g, "_") // jamais un séparateur de chemin — affiché seulement, jamais utilisé pour un chemin disque
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (!base) throw { status: 400, message: "Le nom du document ne peut pas être vide" };
  if (base.length > 255) throw { status: 400, message: "Le nom du document est trop long (255 caractères maximum)" };
  return base;
}

function otherDocumentDateRange(filters) {
  const where = {};
  if (filters.startDate || filters.endDate) {
    where.createdAt = {};
    if (filters.startDate) where.createdAt[Op.gte] = new Date(filters.startDate);
    if (filters.endDate) where.createdAt[Op.lte] = new Date(`${filters.endDate}T23:59:59.999`);
  }
  return where;
}

// Recherche (§15) + filtres date/type (§16) — jamais de ré-extraction, juste
// une lecture filtrée des métadonnées déjà enregistrées.
async function listImportDocuments(module, filters = {}) {
  assertValidImportModule(module);
  const where = { module, entityId: null, ...otherDocumentDateRange(filters) };
  const clauses = [where];
  if (filters.search) clauses.push(repo.otherDocumentSearchClause(filters.search));
  if (filters.type) {
    const typeClause = repo.otherDocumentTypeClause(filters.type);
    if (typeClause) clauses.push(typeClause);
  }
  const finalWhere = clauses.length > 1 ? { [Op.and]: clauses } : where;

  const { page, pageSize, limit, offset } = toPage(filters);
  // `include` toujours fourni à `countDocuments` (même si `finalWhere` ne
  // référence pas `uploader` cette fois) — évite de dupliquer la logique
  // "le where référence-t-il l'association ?" ici, `include` seul sans
  // condition dessus ne change jamais le résultat d'un COUNT sur une
  // association belongsTo (1 ligne par document, jamais de duplication).
  const uploaderInclude = [{ model: User, as: "uploader", attributes: [] }];
  const [data, total] = await Promise.all([
    repo.findDocuments(finalWhere, { limit, offset }),
    repo.countDocuments(finalWhere, { include: uploaderInclude }),
  ]);
  return { data, total, page, pageSize };
}

// Upload/scan (§4-6) — "Scan Document" et "Upload Document" arrivent tous
// deux ici en tant que fichier multipart classique (un scanner "logiciel"
// n'est qu'un sélecteur fichier/caméra côté navigateur, voir
// finance_upload_dropzone.dart) : AUCUNE branche de code différente entre
// les deux, et surtout AUCUN appel à invoiceOcr/deliveryNoteOcr/
// purchaseOrderFieldExtraction/invoiceFieldExtraction — contrairement à
// processInvoiceUpload/processShipmentUpload/uploadRawMaterial ci-dessus et
// ci-dessous, cette fonction ne lit JAMAIS le contenu du fichier.
async function uploadImportDocument(module, file, actor) {
  assertValidImportModule(module);
  const originalName = sanitizeOriginalName(file.originalname);
  try {
    const document = await repo.createDocument({
      module,
      entityId: null,
      originalName,
      displayName: originalName, // §6 : identique à originalName au moment de l'upload
      storedFileName: file.filename,
      fileUrl: docUrl(file),
      mimeType: file.mimetype,
      fileSize: file.size,
      uploadedBy: actor.id,
    });

    await repo.logActivity({
      entityType: "DOCUMENT",
      entityId: document.id,
      userId: actor.id,
      type: "UPLOAD_OTHER_DOCUMENT",
      message: `Document "${originalName}" ajouté (${module})`,
    });

    return repo.findDocumentById(document.id);
  } catch (err) {
    await fs.promises.unlink(file.path).catch(() => {});
    throw err.status ? err : { status: 500, message: "Échec de l'enregistrement du document" };
  }
}

// Renommage (§7/§12/§19) — modifie UNIQUEMENT `displayName`, jamais
// `originalName`/`storedFileName`/`fileUrl` : le fichier physique et son URL
// restent inchangés, l'utilisateur ne peut pas altérer le chemin réel.
async function renameImportDocument(module, id, displayName, actor) {
  assertValidImportModule(module);
  const document = await repo.findDocumentById(id);
  if (!document || document.module !== module) throw { status: 404, message: "Document introuvable" };

  const clean = sanitizeDisplayName(displayName);
  const previousName = document.displayName ?? document.originalName;
  await repo.updateDocument(document, { displayName: clean });

  await repo.logActivity({
    entityType: "DOCUMENT",
    entityId: document.id,
    userId: actor.id,
    type: "RENAME_OTHER_DOCUMENT",
    message: `Document renommé "${previousName}" → "${clean}"`,
  });

  return repo.findDocumentById(id);
}

// Suppression (§10) — réelle en base + fichier physique, jamais un soft
// delete. Contrairement à `deleteEntityWithDocuments` (qui supprime des
// documents RATTACHÉS À une entité parente), ici le document EST l'entité :
// une seule ligne, transaction à une seule écriture (cohérence conservée
// malgré tout, même style que les suppressions Purchase Order/Shipment/
// Invoice ci-dessus).
async function deleteImportDocument(module, id, actor) {
  assertValidImportModule(module);
  const document = await repo.findDocumentById(id);
  if (!document || document.module !== module) throw { status: 404, message: "Document introuvable" };

  const originalName = document.displayName ?? document.originalName;
  await sequelize.transaction(async (t) => {
    await repo.destroyDocument(document, { transaction: t });
  });

  const filePath = path.join(UPLOAD_DIR, document.storedFileName);
  try {
    await fs.promises.unlink(filePath);
  } catch (_) {
    // Fichier déjà absent du disque — ne bloque jamais la suppression en base.
  }

  await repo.logActivity({
    entityType: "DOCUMENT",
    entityId: id,
    userId: actor.id,
    type: "DELETE_OTHER_DOCUMENT",
    message: `Document "${originalName}" supprimé (${module})`,
  });

  return { id };
}

// ── Finance > Other — enveloppes rétro-compatibles ─────────────────────────
// Comportement IDENTIQUE à avant cette modification (mêmes signatures, même
// résultat) : le module reste figé sur OTHER_MODULE, jamais exposé au
// client. Utilisées par les routes "/other-documents" existantes,
// inchangées (voir finance.routes.js).
const listOtherDocuments = (filters) => listImportDocuments(OTHER_MODULE, filters);
const uploadOtherDocument = (file, actor) => uploadImportDocument(OTHER_MODULE, file, actor);
const renameOtherDocument = (id, displayName, actor) => renameImportDocument(OTHER_MODULE, id, displayName, actor);
const deleteOtherDocument = (id, actor) => deleteImportDocument(OTHER_MODULE, id, actor);

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

// Identifiant métier "Shipment #" (§MODIFICATION — CUSTOMER SHIPMENTS) —
// format "SH-00001", généré INCONDITIONNELLEMENT (contrairement à `reference`
// ci-dessus, qui n'est auto-générée que si l'OCR n'a pas détecté de numéro
// de BL fiable). Un seul compteur global, jamais lié à l'année. Généré UNE
// SEULE FOIS par Customer Shipment (jamais par ligne produit) — voir
// l'unique appel dans processShipmentUpload.
async function generateShipmentNumber(transaction) {
  const prefix = "SH-";
  const count = await repo.countShipments({ shipmentNumber: { [Op.like]: `${prefix}%` } }, { transaction });
  return `${prefix}${String(count + 1).padStart(5, "0")}`;
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
// §CORRECTION — WORKFLOW OCR CUSTOMER SHIPMENTS (2026-08-31) : un document
// qui n'est PAS un vrai Bon de Livraison (facture, page blanche scannée,
// document sans rapport...) peut faire lire à l'OCR un texte beaucoup plus
// long que ce qu'attend une colonne VARCHAR bornée (ex. `reference`
// STRING(100), `customerName` STRING(255) — voir models/FinanceShipment.js)
// — Postgres renvoie alors "value too long for type character varying(N)",
// une VRAIE SequelizeDatabaseError (PAS une SequelizeUniqueConstraintError),
// qui n'est donc jamais retentée par la boucle ci-dessous et remonte comme
// un 500 générique pour un cas pourtant parfaitement normal ("document
// incompatible", déjà géré par OCR_FAILED/NEEDS_REVIEW pour toutes les
// AUTRES formes d'échec). Ce clamp élimine catégoriquement cette classe
// d'erreur AVANT l'insertion — la valeur BRUTE, non tronquée, reste de
// toute façon conservée intégralement dans `ocrExtraction` (JSONB, sans
// limite de longueur) pour audit ; seule la colonne relationnelle bornée
// reçoit la version tronquée. Ne touche ni à l'OCR ni à l'extraction elle-
// même — uniquement à la sauvegarde.
function clampToColumn(value, maxLength) {
  if (typeof value !== "string") return value;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

// §CORRECTION — WORKFLOW OCR CUSTOMER SHIPMENTS (2026-08-31) : même principe
// que clampToColumn ci-dessus, pour les colonnes NUMÉRIQUES bornées
// (finance_shipments.totalQuantity DECIMAL(12,2), finance_shipment_items.
// quantity DECIMAL(12,3) — voir les modèles correspondants). Un document
// sans rapport (ex. un rapport texte confondu avec un Bon de Livraison, où
// l'extraction "lignes produit" capture des fragments de texte non
// numériques ou des nombres aberrants) peut produire une valeur non finie
// ou hors plage — Postgres rejette alors l'insertion ("numeric field
// overflow"/"invalid input syntax"), une VRAIE erreur SQL qui ne doit
// jamais faire échouer tout l'upload : la valeur est simplement traitée
// comme non détectée (null), jamais inventée/arrondie.
function safeNumeric(value, maxAbs) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.abs(value) > maxAbs ? null : value;
}

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
        const reference = clampToColumn(
          hasReliableDeliveryNumber ? extraction.deliveryNumber.value : await generateShipmentReference(t),
          100
        );
        const shipmentNumber = await generateShipmentNumber(t);

        const shipment = await repo.createShipment(
          {
            shipmentNumber,
            reference,
            customerReference: clampToColumn(extraction.reference.value, 150),
            customerId: null, // jamais résolu automatiquement vers un client existant (nom/tél/adresse lus, pas un id)
            customerName: clampToColumn(extraction.customer.name.value, 255),
            customerPhone: clampToColumn(extraction.customerPhone.value, 50),
            customerAddress: extraction.customer.address.value,
            customerGovernorate: clampToColumn(extraction.customer.governorate.value, 100),
            customerTaxId: clampToColumn(extraction.customer.taxId.value, 100),
            customerCode: clampToColumn(extraction.customer.code.value, 100),
            customerHeadOfficeAddress: extraction.customer.headOfficeAddress.value,
            truckRegistration: clampToColumn(extraction.delivery.truckRegistration.value, 50),
            truckManufacturer: clampToColumn(extraction.delivery.manufacturer.value, 100),
            driverName: clampToColumn(extraction.delivery.driverName.value, 150),
            deliveryAddress: extraction.delivery.deliveryAddress.value,
            shipmentDate: extraction.deliveryDate.value,
            products: [],
            totalQuantity: safeNumeric(extraction.total.value, 1e9),
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
            extraction.items.map((it, i) => {
              // §CORRECTION EXTRACTION — SÉPARATION UNITÉ / DIAMÈTRE : filet
              // de sécurité si `unit` arrive fusionné ("M² 10") malgré
              // l'extraction positionnelle — jamais retouché si `diameter`
              // est déjà rempli (voir normalizeUnitAndDiameter).
              const { unit, diameter } = normalizeUnitAndDiameter(it.unit, it.diameter);
              return {
                shipmentId: shipment.id,
                sortOrder: i,
                reference: clampToColumn(it.reference ?? null, 100),
                designation: it.designation ?? null,
                unit: clampToColumn(unit ?? null, 50),
                diameter: clampToColumn(diameter ?? null, 50),
                meshSize: clampToColumn(it.meshSize ?? null, 50),
                quantity: safeNumeric(it.quantity ?? null, 1e9),
              };
            }),
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
      // Course rare sur un champ auto-généré — référence de repli OU
      // Shipment # (généré INCONDITIONNELLEMENT, voir generateShipmentNumber)
      // — deux requêtes concurrentes comptent la même valeur suivante → un
      // nouvel essai suffit. Jamais retenté si le VRAI numéro de BL détecté
      // par OCR est le champ réellement en conflit (véritable doublon
      // métier) — `err.fields` (fourni par Postgres/Sequelize) identifie la
      // colonne en cause quand disponible, avec repli sur l'ancien
      // comportement (tout conflit = auto-référence) s'il ne l'est pas.
      const conflictFields = err?.fields ? Object.keys(err.fields) : [];
      const isShipmentNumberConflict = err?.name === "SequelizeUniqueConstraintError" && conflictFields.includes("shipmentNumber");
      const isAutoReferenceConflict =
        err?.name === "SequelizeUniqueConstraintError" &&
        !hasReliableDeliveryNumber &&
        (!conflictFields.length || conflictFields.includes("reference"));
      if ((isShipmentNumberConflict || isAutoReferenceConflict) && attempt < MAX_ATTEMPTS) continue;

      await Promise.all(files.map((f) => fs.promises.unlink(f.path).catch(() => {})));

      if (hasReliableDeliveryNumber && err?.name === "SequelizeUniqueConstraintError" && !isShipmentNumberConflict) {
        throw { status: 409, message: `Un shipment avec le numéro "${extraction.deliveryNumber.value}" existe déjà` };
      }
      // §CORRECTION — WORKFLOW OCR CUSTOMER SHIPMENTS (2026-08-31) : la
      // cause RÉELLE de l'erreur (message + stack) était jusqu'ici perdue —
      // seul le message générique "Échec du traitement..." (déjà renvoyé au
      // client) atteignait les logs. Cette ligne ne change AUCUN
      // comportement HTTP (même throw ensuite) : elle rend seulement visible
      // en logs ce qui a réellement échoué, pour distinguer une vraie
      // erreur serveur (bug/DB) d'un cas métier normal (document illisible,
      // déjà géré plus haut via status=OCR_FAILED — voir ocrFailed).
      logger.error("[DELIVERY] Échec réel du traitement (avant enveloppe générique) :", err?.stack || err?.message || err);
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
  // Factured Shipments (§8) : une facture payée est retirée de cette liste
  // dès l'enregistrement du paiement (elle apparaît alors dans Paid
  // Factures — voir listPaidInvoices ci-dessous) — sauf si l'appelant
  // filtre explicitement sur un statut donné (y compris "PAID").
  else where.status = { [Op.ne]: "PAID" };
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

// §CORRECTION — FACTURED SHIPMENTS / PAID INVOICES (2026-09-01) : "Invoice
// date" éditable directement depuis le tableau "Sage Documents" (§1 du
// ticket) — même principe que updateRawMaterial/updateShipment (endpoint
// dédié, réutilise `repo.updateInvoice`, déjà utilisé par registerPayment
// ci-dessus, jamais une deuxième implémentation de mise à jour).
async function updateInvoice(id, body, actor) {
  const invoice = await repo.findInvoiceById(id);
  if (!invoice) throw { status: 404, message: "Facture introuvable" };

  await repo.updateInvoice(invoice, { invoiceDate: body.invoiceDate });

  await repo.logActivity({
    entityType: "INVOICE",
    entityId: id,
    userId: actor.id,
    type: "UPDATE_INVOICE_DATE",
    message: `Invoice date mise à jour ("${body.invoiceDate}") pour la facture "${invoice.invoiceNumber}"`,
  });

  return getInvoice(id);
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
  // Certaines factures n'impriment aucun "Total TTC" — seulement "NET À
  // PAYER" (§11) : c'est le montant bas de page déjà calculé par le
  // document, priorité sur un recalcul HT+Taxe côté serveur (jamais inventer
  // une valeur quand elle est déjà imprimée ailleurs sur le document).
  const total =
    extraction.totals.totalTTC.value != null
      ? extraction.totals.totalTTC.value
      : extraction.totals.netToPay?.value != null
        ? extraction.totals.netToPay.value
        : amount != null && tax != null
          ? amount + tax
          : null;

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let invoiceId;
    try {
      await sequelize.transaction(async (t) => {
        const invoiceNumber = clampToColumn(
          hasReliableInvoiceNumber ? extraction.invoiceNumber.value : await generateInvoiceNumber(t),
          100
        );

        const invoice = await repo.createInvoice(
          {
            invoiceNumber,
            reference: clampToColumn(extraction.reference.value, 150),
            customerId: null, // jamais résolu automatiquement vers un client existant (nom/tél/adresse lus, pas un id)
            customerName: clampToColumn(extraction.customer.name.value, 255),
            customerPhone: clampToColumn(extraction.customer.phone.value, 50),
            customerAddress: extraction.customer.address.value,
            customerGovernorate: clampToColumn(extraction.customer.governorate.value, 100),
            customerTaxId: clampToColumn(extraction.customer.taxId.value, 100),
            customerCode: clampToColumn(extraction.customer.code.value, 100),
            invoiceDate: extraction.invoiceDate.value,
            amount: safeNumeric(amount, 1e11) ?? 0,
            tax: safeNumeric(tax, 1e11) ?? 0,
            total: safeNumeric(total, 1e11) ?? 0,
            downPayment: safeNumeric(extraction.totals.downPayment?.value ?? null, 1e11),
            netToPay: safeNumeric(extraction.totals.netToPay?.value ?? null, 1e11),
            paymentCondition: clampToColumn(extraction.payment?.condition?.value ?? null, 150),
            paymentDate: extraction.payment?.date?.value ?? null,
            paymentMethod: clampToColumn(extraction.payment?.method?.value ?? null, 50),
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
            extraction.items.map((it, i) => {
              // §CORRECTION EXTRACTION — SÉPARATION UNITÉ / DIAMÈTRE : voir
              // le même filet de sécurité côté Shipment ci-dessus.
              const { unit, diameter } = normalizeUnitAndDiameter(it.unit, it.diameter);
              return {
                invoiceId: invoice.id,
                sortOrder: i,
                reference: clampToColumn(it.reference ?? null, 100),
                designation: it.designation ?? null,
                unit: clampToColumn(unit ?? null, 50),
                diameter: clampToColumn(diameter ?? null, 50),
                meshSize: clampToColumn(it.meshSize ?? null, 50),
                quantity: safeNumeric(it.quantity ?? null, 1e9),
                unitPriceHT: safeNumeric(it.unitPriceHT ?? null, 1e11),
                rms: safeNumeric(it.rms ?? null, 1e9),
                amountHT: safeNumeric(it.amountHT ?? null, 1e11),
                tax1: safeNumeric(it.tax1 ?? null, 1e11),
                tax2: safeNumeric(it.tax2 ?? null, 1e11),
              };
            }),
            { transaction: t }
          );
        }

        if (extraction.taxes && extraction.taxes.length) {
          await repo.createInvoiceTaxes(
            extraction.taxes.map((tx, i) => ({
              invoiceId: invoice.id,
              sortOrder: i,
              code: clampToColumn(tx.code ?? null, 20),
              base: safeNumeric(tx.base ?? null, 1e11),
              rate: safeNumeric(tx.rate ?? null, 9999),
              amount: safeNumeric(tx.amount ?? null, 1e11),
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
      // §CORRECTION — WORKFLOW OCR FACTURED SHIPMENTS (2026-08-31) : même
      // correctif que processShipmentUpload ci-dessus — la cause RÉELLE de
      // l'erreur était perdue avant d'atteindre les logs.
      logger.error("[INVOICE] Échec réel du traitement (avant enveloppe générique) :", err?.stack || err?.message || err);
      throw err.status ? err : { status: 500, message: "Échec du traitement de la facture" };
    }
  }
}

// Champs spécifiques à chaque mode de règlement — mis à NULL pour tous les
// modes qui ne les nécessitent pas, quoi que le client ait pu envoyer
// (§COMPORTEMENT SELON PAYMENT METHOD : "Les champs spécifiques doivent
// être NULL pour les méthodes qui ne les nécessitent pas"). Le nouveau
// formulaire minimal (Virement/Versement/Chèque/Traite) ne les collecte
// plus du tout — cette table reste utile pour ignorer silencieusement
// d'éventuels champs résiduels envoyés par un ancien client, jamais requise.
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

  // Formulaire minimal (§2/§6) : method + justificatif SEULS demandés à
  // l'utilisateur. Le justificatif est obligatoire (vérifié ici — req.file
  // n'est pas dans req.body, donc pas validable par Joi) ; amount/paidDate
  // ne sont plus saisis manuellement, on les déduit du contexte plutôt que
  // de bloquer l'enregistrement pour des champs que l'UI ne collecte plus
  // (§5) : montant = total de la facture (paiement complet), date = date de
  // règlement déjà extraite par l'OCR, sinon aujourd'hui.
  //
  // §CORRECTION — REGISTER PAYMENT DEPUIS SCAN DOCUMENTS (2026-08-31, §3 du
  // ticket) : "Espèce" est l'unique mode où AUCUN justificatif n'est requis
  // ("aucun document de paiement supplémentaire n'est obligatoire") — tous
  // les autres modes (y compris le nouveau "Carte bancaire") conservent
  // l'exigence existante.
  if (!file && body.method !== "Espèce") {
    throw { status: 400, message: "Un justificatif est requis pour enregistrer le paiement" };
  }

  const amount = body.amount != null ? body.amount : Number(invoice.total) || 0;
  const paidDate = body.paidDate || invoice.paymentDate || new Date().toISOString().slice(0, 10);

  const allowedFields = new Set(PAYMENT_METHOD_FIELDS[body.method] || []);
  const paymentData = { invoiceId, amount, paidDate, method: body.method, reference: body.reference || null };
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
      // §CORRECTION — REGISTER PAYMENT / TOTAL À 0 (2026-09-01, §2-§4 du
      // ticket) : `total > 0 && totalPaid >= total` ne peut JAMAIS être vrai
      // quand l'OCR n'a pas réussi à extraire le total (total=0, cas
      // fréquent pour les factures dans "Scan Documents") — Register
      // Payment retournait 201/success=true mais la facture restait
      // invisible dans Paid Invoices EN PERMANENCE, quel que soit le
      // paiement enregistré. Un total <= 0 signifie "aucune référence
      // fiable à comparer" : l'action même de Register Payment fait foi et
      // marque la facture payée, exactement comme un total réel entièrement
      // couvert le ferait déjà.
      if (total <= 0 || totalPaid >= total) status = "PAID";
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
  getDashboardMonthly,
  listRawMaterials,
  processRawMaterialUpload,
  getRawMaterial,
  updateRawMaterial,
  deleteRawMaterial,
  addRawMaterialDocuments,
  deleteRawMaterialDocument,
  listOtherDocuments,
  uploadOtherDocument,
  renameOtherDocument,
  deleteOtherDocument,
  listImportDocuments,
  uploadImportDocument,
  renameImportDocument,
  deleteImportDocument,
  RAW_MATERIALS_MODULE,
  SHIPMENT_MODULE,
  INVOICE_MODULE,
  PAID_INVOICE_IMPORT_MODULE,
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
  updateInvoice,
  processInvoiceUpload,
  registerPayment,
  deleteInvoice,
};
