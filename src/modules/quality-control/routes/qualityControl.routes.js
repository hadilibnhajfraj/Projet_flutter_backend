"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/qualityControl.controller");
const { validateCreate, validateUpdate, validateValidate, validateMatchQuery, validateReadingCreate, validateReadingSave } = require("../validators/qualityControl.validator");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");
const cfg = require("../../../config/qualityControl");

// RBAC existant (requireRole + moduleAccessGuard) — aucun système parallèle.
// Saisie (créer/remplir/valider/modifier) : UNIQUEMENT controle_qualite
// (ses propres contrôles, portée appliquée dans le service). Consultation :
// controle_qualite + admins. Suppression (logique) : BROUILLONS uniquement
// (controle_qualite : les siens ; admins : tous). Un contrôle VALIDÉ est en
// lecture seule pour tous : PUT / validate / DELETE → 403 CONTROL_LOCKED.
const WRITE_ROLES = cfg.writeRoles;
const READ_ROLES = cfg.readRoles;
const DELETE_ROLES = cfg.deleteRoles;

router.use(authRequired);

// IMPORTANT : déclarés avant "/:id" (même piège que por-promesh).
router.get("/parameters", requireRole(...READ_ROLES), ctrl.listParameters);
router.get("/config", requireRole(...READ_ROLES), ctrl.getConfig);
// Tableau de bord : agrégats par ligne / machine / statut (une seule requête HTTP).
router.get("/stats", requireRole(...READ_ROLES), ctrl.getStats);
// Historique : export des données FILTRÉES (xlsx | pdf | csv), mêmes filtres
// que GET /quality-control. Comparaison qualité période A / période B.
router.get("/export", requireRole(...READ_ROLES), ctrl.exportHistory);
router.get("/comparison", requireRole(...READ_ROLES), ctrl.comparison);
router.get("/comparison/export", requireRole(...READ_ROLES), ctrl.exportComparison);
// Recherche automatique de la fiche de production (ligne + machine + date de
// production + poste) : indique seulement SI une fiche unique correspond —
// l'association elle-même est recalculée par le serveur à la sauvegarde.
router.get("/production-match", requireRole(...READ_ROLES), validateMatchQuery, ctrl.productionMatch);
router.get("/production/:productionRecordId", requireRole(...READ_ROLES), ctrl.listByProductionRecord);

router.get("/", requireRole(...READ_ROLES), ctrl.listControls);
router.post("/", requireRole(...WRITE_ROLES), validateCreate, ctrl.createControl);

router.get("/:id", requireRole(...READ_ROLES), ctrl.getControl);
router.put("/:id", requireRole(...WRITE_ROLES), validateUpdate, ctrl.updateControl);
router.post("/:id/validate", requireRole(...WRITE_ROLES), validateValidate, ctrl.validateControl);
router.delete("/:id", requireRole(...DELETE_ROLES), ctrl.deleteControl);

// PRÉLÈVEMENTS d'une fiche (heure du contrôle + paramètres) : saisie réservée à
// controle_qualite. Fiche validée → 403 CONTROL_LOCKED ; prélèvement validé →
// 403 READING_LOCKED ; heure déjà utilisée dans la fiche → 409
// READING_TIME_EXISTS (+ existingReadingId).
router.post("/:id/readings", requireRole(...WRITE_ROLES), validateReadingCreate, ctrl.createReading);
router.put("/:id/readings/:readingId", requireRole(...WRITE_ROLES), validateReadingSave, ctrl.updateReading);
router.post("/:id/readings/:readingId/validate", requireRole(...WRITE_ROLES), validateReadingSave, ctrl.validateReading);
router.delete("/:id/readings/:readingId", requireRole(...WRITE_ROLES), ctrl.deleteReading);

module.exports = router;
