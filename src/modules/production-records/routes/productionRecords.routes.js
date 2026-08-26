"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/productionRecords.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

// Lecture seule (aucun create/update/delete — la saisie reste sur les
// écrans-module PROMESH/PROBAR existants) — mêmes rôles que por-promesh et
// industrial-records, dont cette page centralise la consultation.
// finance_production (§MODIFICATION — INTERFACE PRODUCTION DE
// DENNISREDFEATHER) reçoit le même accès que responsable_logistique_achat.
const READ_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat", "finance_production"];

router.use(authRequired);
router.use(requireRole(...READ_ROLES));

// IMPORTANT : "/filters" et "/summary" déclarés avant "/:id" — sinon Express
// route GET /production-records/filters (ou /summary) vers getById avec
// id="filters"/"summary" (même piège que por-promesh, voir porPromesh.routes.js).
router.get("/filters", ctrl.filters);
router.get("/summary", ctrl.summary);
// §MODIFICATION — ADMIN > PRODUCTION RECORDS — FILTRE PAR UTILISATEUR (§3) :
// alimente le dropdown "All users" ; scope de rôle appliqué dans le service
// (getCreators) — un compte owner-scoped (production_1..5, responsable_
// logistique) ne reçoit jamais que lui-même, jamais la liste des autres.
router.get("/creators", ctrl.creators);

router.get("/", ctrl.list);
router.get("/:id", ctrl.getById);

module.exports = router;
