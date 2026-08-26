"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/finance.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");
const { financeDocumentUpload } = require("../../../middleware/financeDocumentUpload.middleware");
const { handleUploadError } = require("../../../middleware/projectAction.validation");
const {
  validateCreateShipment,
  validateUpdateShipment,
  validateCreateInvoice,
  validateRegisterPayment,
} = require("../validators/finance.validator");

// Le module Finance est un espace dédié — rôle finance_probar + les mêmes
// tiers admin que les autres modules (aucun droit admin supplémentaire
// accordé, uniquement l'accès en lecture/écriture à ce module précis).
// finance_production (§MODIFICATION — INTERFACE PRODUCTION DE
// DENNISREDFEATHER) conserve le même accès Finance que finance_probar, en
// plus de son accès Production (voir por-promesh/industrial-records/
// production-records routes).
const FINANCE_ROLES = ["admin", "superadmin", "superadmin2", "finance_probar", "finance_production"];

// POST /shipments est du multipart/form-data (pièces jointes) — tout champ
// non-fichier y arrive en STRING, y compris "products" que le client envoie
// en JSON.stringify(...). Sans ce parsing, le validateur Joi (qui attend un
// vrai tableau) rejette systématiquement la requête. Les champs scalaires
// (customerId/totalAmount/...) n'ont pas ce problème : Joi les convertit
// automatiquement (`convert: true` par défaut).
function parseShipmentProductsField(req, _res, next) {
  if (typeof req.body?.products === "string") {
    try {
      req.body.products = JSON.parse(req.body.products);
    } catch (_) {
      // laisse le validateur Joi rejeter proprement une valeur invalide.
    }
  }
  next();
}

router.use(authRequired);
router.use(requireRole(...FINANCE_ROLES));

router.get("/dashboard", ctrl.getDashboard);
router.get("/dashboard/monthly", ctrl.getDashboardMonthly);

// ── Inflow of raw materials ────────────────────────────────────────────
// IMPORTANT : "/raw-materials/upload" déclaré avant "/raw-materials/:id"
// (même piège que por-promesh/production-records — même méthode HTTP
// utiliserait sinon le mauvais handler selon l'ordre).
router.get("/raw-materials", ctrl.listRawMaterials);
router.post("/raw-materials/upload", financeDocumentUpload.single("file"), handleUploadError, ctrl.uploadRawMaterial);
router.get("/raw-materials/:id", ctrl.getRawMaterial);
router.delete("/raw-materials/:id", ctrl.deleteRawMaterial);

// ── Shipment of products to the customers ──────────────────────────────
// "New shipment" simplifié : le formulaire ne contient plus que "Supporting
// documents" — cette unique route crée le Shipment ET ses documents de façon
// atomique (voir finance.service.js#createShipment), jamais l'un sans
// l'autre. Le champ multipart reste "documents" (déjà en place).
router.get("/shipments", ctrl.listShipments);
router.post(
  "/shipments",
  financeDocumentUpload.array("documents", 10),
  handleUploadError,
  parseShipmentProductsField,
  validateCreateShipment,
  ctrl.createShipment
);
router.get("/shipments/:id", ctrl.getShipment);
router.put("/shipments/:id", validateUpdateShipment, ctrl.updateShipment);
router.delete("/shipments/:id", ctrl.deleteShipment);

// ── Factured shipments - by facture / Paid factures ─────────────────────
// IMPORTANT : "/paid-invoices" déclaré avant "/invoices/:id" n'est pas
// nécessaire ici (préfixes distincts), mais "/invoices/:id/payments" DOIT
// être déclaré après "/invoices/:id" pour rester lisible (Express matche de
// toute façon sur la méthode + la forme exacte du chemin, aucune ambiguïté
// réelle entre les deux).
//
// POST /invoices sert DEUX flux sur la même route :
//   - JSON (flux historique "facture depuis un shipment", sans fichier) ;
//   - multipart/form-data (modal "Upload invoice", champ "documents", ≥1
//     fichier) — crée la facture ET ses documents de façon atomique (voir
//     finance.service.js#createInvoice), jamais l'un sans l'autre.
// multer laisse passer les requêtes non-multipart sans y toucher (req.body
// déjà peuplé par express.json() en amont) — aucun conflit entre les deux.
router.get("/invoices", ctrl.listInvoices);
router.post(
  "/invoices",
  financeDocumentUpload.array("documents", 10),
  handleUploadError,
  validateCreateInvoice,
  ctrl.createInvoice
);
router.get("/invoices/:id", ctrl.getInvoice);
// "Register payment" — document justificatif optionnel (Chèque/Traite
// uniquement, champ multipart "document") ; multer laisse passer les
// requêtes sans fichier (Carte bancaire/Espèce) sans y toucher.
router.post(
  "/invoices/:id/payments",
  financeDocumentUpload.single("document"),
  handleUploadError,
  validateRegisterPayment,
  ctrl.registerPayment
);
router.delete("/invoices/:id", ctrl.deleteInvoice);

router.get("/paid-invoices", ctrl.listPaidInvoices);
router.get("/paid-invoices/:id", ctrl.getInvoice);

// ── Finance > Other (§MODIFICATION — SCAN SIMPLE DE DOCUMENTS) ──────────
// Stockage documentaire pur, AUCUN OCR/extraction déclenché (voir
// finance.service.js#uploadOtherDocument) — le fichier reste directement
// accessible via son `fileUrl` statique existant (`/uploads/finance-
// documents/...`, déjà servi — voir app.js), pas de route "view" dédiée :
// le viewer PDF/image générique côté frontend (déjà utilisé par les 3
// autres modules Finance) le consomme tel quel.
router.get("/other-documents", ctrl.listOtherDocuments);
router.post("/other-documents", financeDocumentUpload.single("file"), handleUploadError, ctrl.uploadOtherDocument);
router.patch("/other-documents/:id", ctrl.renameOtherDocument);
router.delete("/other-documents/:id", ctrl.deleteOtherDocument);

module.exports = router;
