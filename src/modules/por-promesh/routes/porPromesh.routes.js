"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/porPromesh.controller");
const { validateCreate, validateUpdate, validateCreateOrOpenDraft } = require("../validators/porPromesh.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");
const { attachmentUpload } = require("../../../middleware/porPromeshAttachment.middleware");
const { handleUploadError } = require("../../../middleware/projectAction.validation");

// Create/read/update: admin, superadmin, and the logistics/purchasing role
// (the latter scoped to its own fiches — enforced in the service layer).
// finance_production (§MODIFICATION — INTERFACE PRODUCTION DE
// DENNISREDFEATHER) gets the same Production read/write scope as
// responsable_logistique_achat, in addition to its existing Finance access.
const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat", "finance_production"];
// Delete is intentionally admin/superadmin only — not part of the granted
// permissions for responsable_logistique_achat nor finance_production.
const DELETE_ROLES = ["admin", "superadmin", "superadmin2"];

router.use(authRequired);

router.post("/", requireRole(...READ_WRITE_ROLES), validateCreate, ctrl.createPorPromesh);
router.get("/", requireRole(...READ_WRITE_ROLES), ctrl.listPorPromesh);

// Bouton "Nouvelle fiche" — rouvre le brouillon en cours ou en crée un.
router.post("/new", requireRole(...READ_WRITE_ROLES), validateCreateOrOpenDraft, ctrl.createOrOpenDraft);

// Liste déroulante "Opérateur" — ouvert aux mêmes rôles que la création/
// modification de fiches (pas réservé admin/superadmin comme GET /users).
router.get("/operators", requireRole(...READ_WRITE_ROLES), ctrl.listOperators);

// IMPORTANT : déclarés avant "/:id" — sinon Express route "/dashboard" et
// "/stats" vers getPorPromesh avec id="dashboard"/"stats".
router.get("/dashboard", requireRole(...READ_WRITE_ROLES), ctrl.getDashboard);
router.get("/stats", requireRole(...READ_WRITE_ROLES), ctrl.getStats);

router.get("/:id", requireRole(...READ_WRITE_ROLES), ctrl.getPorPromesh);
router.put("/:id", requireRole(...READ_WRITE_ROLES), validateUpdate, ctrl.updatePorPromesh);
router.delete("/:id", requireRole(...DELETE_ROLES), ctrl.deletePorPromesh);

// Verrouillage définitif (BROUILLON → VALIDE) : l'auteur de la fiche
// (responsable_logistique_achat) doit pouvoir terminer sa propre saisie —
// même restriction que create/update, pas que DELETE. L'ownership (on ne
// valide que ses propres fiches pour ce rôle) reste vérifié dans le service.
router.post("/:id/validate", requireRole(...READ_WRITE_ROLES), ctrl.validatePorPromesh);

router.get("/:id/pdf", requireRole(...READ_WRITE_ROLES), ctrl.getPorPromeshPdf);

router.post(
  "/:id/attachments",
  requireRole(...READ_WRITE_ROLES),
  attachmentUpload.single("file"),
  handleUploadError,
  ctrl.addAttachment
);

module.exports = router;
