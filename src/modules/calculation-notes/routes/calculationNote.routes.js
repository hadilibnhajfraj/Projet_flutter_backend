"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/calculationNote.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");
const { handleCalculationNoteUpload } = require("../middleware/calculationNoteUpload");
const { MODULE_ROLES } = require("../services/calculationNote.service");
const { ROLE: BACKOFFICE_ROLE } = require("../../../config/backofficeReadOnly");

// Module « Notes de calcul » — /calculation-notes.
// Rôles CRM uniquement ; la portée de lecture et les droits d'écriture sont
// revérifiés par le service pour chaque note (voir calculationNote.service.js).
// Le compte back-office ne passe jamais par les écritures : readOnlyRoleGuard
// (monté avant) les refuse en 403.
// Valider / Refuser : aussi le compte back-office, avec son identité réelle
// (exception étroite de middleware/readOnlyRoleGuard). Déclarées AVANT le
// contrôle de rôle général du module.
router.post("/:id/validate", authRequired, requireRole(...MODULE_ROLES, BACKOFFICE_ROLE), ctrl.validate);
router.post("/:id/reject", authRequired, requireRole(...MODULE_ROLES, BACKOFFICE_ROLE), ctrl.reject);

router.use(authRequired, requireRole(...MODULE_ROLES));

router.get("/options", ctrl.options);
// Validation : rubrique du validateur et droits de l'utilisateur connecté.
router.get("/permissions", ctrl.permissions);
router.get("/validation", ctrl.validationQueue);
// « Affecter à » : utilisateurs CRM actifs (recherche ?q=).
router.get("/assignable-users", ctrl.assignableUsers);
router.get("/", ctrl.list);
router.post("/", handleCalculationNoteUpload, ctrl.create);
router.get("/:id", ctrl.get);
router.patch("/:id", ctrl.update);
router.get("/:id/history", ctrl.history);
router.post("/:id/documents", handleCalculationNoteUpload, ctrl.addDocuments);
// Documents complémentaires de l'utilisateur affecté (même contrôle des fichiers).
router.post("/:id/complementary-documents", handleCalculationNoteUpload, ctrl.addComplementary);
router.patch("/:id/documents/:docId", ctrl.updateDocument);
router.get("/:id/documents/:docId/download", ctrl.download);
// Décisions (validateur désigné uniquement), annulation (créateur), nouvelle
// soumission après refus — droits revérifiés par le service.
router.post("/:id/cancel", ctrl.cancel);
router.post("/:id/resubmit", ctrl.resubmit);
// Affectation (modification / retrait) et son historique.
router.put("/:id/assignment", ctrl.setAssignment);
router.get("/:id/assignments", ctrl.assignments);
// Suivi des emails de la note et relance des envois en échec.
router.get("/:id/email-notifications", ctrl.emailNotifications);
router.post("/:id/email-notifications/resend", ctrl.resendEmails);

module.exports = router;
