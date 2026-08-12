"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/productionRecords.controller");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requireRole } = require("../../../middleware/requireRole");

// Lecture seule (aucun create/update/delete — la saisie reste sur les
// écrans-module PROMESH/PROBAR existants) — mêmes rôles que por-promesh et
// industrial-records, dont cette page centralise la consultation.
const READ_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat"];

router.use(authRequired);
router.use(requireRole(...READ_ROLES));

// IMPORTANT : "/filters" et "/summary" déclarés avant "/:id" — sinon Express
// route GET /production-records/filters (ou /summary) vers getById avec
// id="filters"/"summary" (même piège que por-promesh, voir porPromesh.routes.js).
router.get("/filters", ctrl.filters);
router.get("/summary", ctrl.summary);

router.get("/", ctrl.list);
router.get("/:id", ctrl.getById);

module.exports = router;
