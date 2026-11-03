"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/porPromesh.controller");
const { validateCreate, validateUpdate, validateCreateOrOpenDraft } = require("../validators/porPromesh.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole, requireRoleOrPermission } = require("../../../middleware/requireRole");
const { PERMISSIONS } = require("../../../config/rolePermissions");
const { attachmentUpload } = require("../../../middleware/porPromeshAttachment.middleware");
const { handleUploadError } = require("../../../middleware/projectAction.validation");
const { complianceGuard } = require("../../production-compliance/middleware/productionComplianceGuard");
const { rawMaterialRequestGuard } = require("../../raw-material-requests/middleware/rawMaterialRequestGuard");

// Create/read/update: admin, superadmin, and the logistics/purchasing role
// (the latter scoped to its own fiches — enforced in the service layer).
// finance_production (§MODIFICATION — INTERFACE PRODUCTION DE
// DENNISREDFEATHER) gets the same Production read/write scope as
// responsable_logistique_achat, in addition to its existing Finance access.
const READ_WRITE_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat", "finance_production"];
// Delete is intentionally admin/superadmin only — not part of the granted
// permissions for responsable_logistique_achat nor finance_production.
const DELETE_ROLES = ["admin", "superadmin", "superadmin2"];
// Consultation (GET uniquement) : + permission production.read_all (compte
// back-office), jamais sur une route d'écriture (création, modification,
// validation, pièces jointes).
const consult = requireRoleOrPermission(PERMISSIONS.PRODUCTION_READ_ALL, ...READ_WRITE_ROLES);

router.use(authRequired);

router.post("/", requireRole(...READ_WRITE_ROLES), validateCreate, complianceGuard({ source: "promesh", mode: "create" }), rawMaterialRequestGuard({ source: "promesh" }), ctrl.createPorPromesh);
router.get("/", consult, ctrl.listPorPromesh);

// Bouton "Nouvelle fiche" — rouvre le brouillon en cours ou en crée un.
router.post("/new", requireRole(...READ_WRITE_ROLES), validateCreateOrOpenDraft, complianceGuard({ source: "promesh", mode: "createDraft" }), rawMaterialRequestGuard({ source: "promesh" }), ctrl.createOrOpenDraft);

// Liste déroulante "Opérateur" — ouvert aux mêmes rôles que la création/
// modification de fiches (pas réservé admin/superadmin comme GET /users).
router.get("/operators", requireRole(...READ_WRITE_ROLES), ctrl.listOperators);

// IMPORTANT : déclarés avant "/:id" — sinon Express route "/dashboard" et
// "/stats" vers getPorPromesh avec id="dashboard"/"stats".
router.get("/dashboard", consult, ctrl.getDashboard);
router.get("/stats", consult, ctrl.getStats);

router.get("/:id", consult, ctrl.getPorPromesh);
router.put("/:id", requireRole(...READ_WRITE_ROLES), validateUpdate, complianceGuard({ source: "promesh", mode: "update" }), ctrl.updatePorPromesh);
router.delete("/:id", requireRole(...DELETE_ROLES), ctrl.deletePorPromesh);

// Verrouillage définitif (BROUILLON → VALIDE) : l'auteur de la fiche
// (responsable_logistique_achat) doit pouvoir terminer sa propre saisie —
// même restriction que create/update, pas que DELETE. L'ownership (on ne
// valide que ses propres fiches pour ce rôle) reste vérifié dans le service.
router.post("/:id/validate", requireRole(...READ_WRITE_ROLES), ctrl.validatePorPromesh);

router.get("/:id/pdf", consult, ctrl.getPorPromeshPdf);

router.post(
  "/:id/attachments",
  requireRole(...READ_WRITE_ROLES),
  attachmentUpload.single("file"),
  handleUploadError,
  ctrl.addAttachment
);

module.exports = router;
