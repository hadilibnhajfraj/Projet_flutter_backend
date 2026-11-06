"use strict";

// Module CONTRÔLE QUALITÉ — TABLEAU DE BORD SUPER ADMIN (lecture seule).
//
// Consultation centralisée de TOUTES les fiches de contrôle qualité
// (quality_controls, hors suppressions logiques), quel que soit le compte
// qui les a créées. Aucune table, aucune donnée dupliquée : mêmes filtres que
// l'Historique (buildListWhere, sans restriction d'auteur), même réponse par
// fiche (withItemsForList), même date effective et même ordre par défaut.
// Le détail d'une fiche reste GET /quality-control/:id (aucun filtre d'auteur
// pour les admins). La route est limitée à cfg.adminDashboardRoles.
//
// Statut d'une fiche : BROUILLON (validatedAt null) = « en attente » ;
// VALIDÉE = son résultat (CONFORME / NON_CONFORME). Le module n'a pas d'état
// « refusée » : « non conformes » = fiches validées au résultat NON_CONFORME
// (même règle que GET /quality-control/stats).

const { Op } = require("sequelize");
const { sequelize } = require("../../../db");
const cfg = require("../../../config/qualityControl");
const QualityControl = require("../../../models/QualityControl");
const qc = require("./qualityControl.service");

const VALIDATED_SQL = `("validatedAt" IS NOT NULL)`;

// Filtre « état » : validated (fiches validées) | draft (en attente).
function adminWhere(filters) {
  const where = qc.buildListWhere(filters, null, { allAuthors: true });
  const state = String(filters.state || "").trim().toLowerCase();
  if (state === "validated") where.validatedAt = { [Op.ne]: null };
  else if (state === "draft") where.validatedAt = null;
  else if (state) throw { status: 400, code: "INVALID_STATE", message: "État invalide (validated, draft)" };
  return where;
}

// Tri des colonnes du tableau : clé → expression. Départage stable : date
// effective puis création (ordre par défaut de l'Historique), puis id.
const SORTS = Object.freeze({
  reference: () => ["reference"],
  productionType: () => ["productionType"],
  date: () => sequelize.literal(qc.EFFECTIVE_TS_SQL),
  controller: () => ["controllerEmail"],
  result: () => ["status"],
  state: () => sequelize.literal(VALIDATED_SQL),
  updatedAt: () => ["updatedAt"],
});

function orderFor(filters) {
  const key = filters.sort ? String(filters.sort) : "date";
  if (!SORTS[key]) throw { status: 400, code: "INVALID_SORT", message: `Tri invalide (${Object.keys(SORTS).join(", ")})` };
  const dir = String(filters.order || "desc").toLowerCase();
  if (!["asc", "desc"].includes(dir)) throw { status: 400, code: "INVALID_ORDER", message: "Ordre invalide (asc, desc)" };
  const col = SORTS[key]();
  const first = Array.isArray(col) ? [...col, dir.toUpperCase()] : [col, dir.toUpperCase()];
  return [first, ...qc.EFFECTIVE_ORDER, ["id", "ASC"]];
}

async function listAllControls(filters) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(filters.limit, 10) || 20));
  const { count, rows } = await QualityControl.findAndCountAll({
    where: adminWhere(filters),
    order: orderFor(filters),
    limit,
    offset: (page - 1) * limit,
  });
  return {
    data: await qc.withItemsForList(rows),
    pagination: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
}

function emptyCounts() {
  return { total: 0, validated: 0, pending: 0, conformes: 0, nonConformes: 0 };
}

function addCount(target, validated, status, n) {
  target.total += n;
  if (!validated) target.pending += n;
  else {
    target.validated += n;
    if (status === qc.STATUS.CONFORME) target.conformes += n;
    else if (status === qc.STATUS.NON_CONFORME) target.nonConformes += n;
  }
}

// Indicateurs : UNE requête GROUP BY (ligne × état × résultat), sur la
// période demandée uniquement (period | from / to — mêmes règles que la liste).
async function getOverview(filters) {
  const { period, from, to } = filters;
  const rows = await QualityControl.findAll({
    where: adminWhere({ period, from, to }),
    attributes: [
      "productionType",
      [sequelize.literal(VALIDATED_SQL), "validated"],
      "status",
      [sequelize.fn("COUNT", sequelize.col("id")), "n"],
    ],
    group: ["productionType", sequelize.literal(VALIDATED_SQL), "status"],
    raw: true,
  });

  const totals = emptyCounts();
  // Lignes de la configuration (PROMESH, PROBAR), puis toute autre ligne
  // réellement présente en base — aucune fiche n'est écartée.
  const byProduct = cfg.productionLines.map((l) => ({ type: l.type, label: l.label, ...emptyCounts() }));
  for (const r of rows) {
    const n = Number(r.n);
    const validated = r.validated === true || r.validated === "true";
    addCount(totals, validated, r.status, n);
    const type = String(r.productionType || "").toUpperCase();
    let line = byProduct.find((l) => l.type === type);
    if (!line) byProduct.push((line = { type, label: type || "—", ...emptyCounts() }));
    addCount(line, validated, r.status, n);
  }
  return {
    period: period || (from || to ? null : "all"),
    from: from || null,
    to: to || null,
    totals,
    byProduct,
  };
}

module.exports = { listAllControls, getOverview, SORTS };
