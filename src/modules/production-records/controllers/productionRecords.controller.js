"use strict";

const svc = require("../services/productionRecords.service");
const logger = require("../../../utils/logger");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) logger.error("ProductionRecords error:", err);
  res.status(status).json({ success: false, message: err.message || "Internal server error" });
}

function actorFrom(req) {
  return { id: req.user.sub, role: req.user.role, email: req.user.email };
}

async function list(req, res) {
  try {
    // §MODIFICATION — ADMIN > PRODUCTION RECORDS — FILTRE PAR UTILISATEUR :
    // `createdBy` (id utilisateur) accepté ici comme n'importe quel autre
    // filtre — sa portée réelle (ignoré pour un rôle owner-scoped) est
    // décidée UNIQUEMENT côté service (applyCreatedByFilter), jamais ici.
    const { type, period, startDate, endDate, machineId, poste, createdBy, search, sort, page, limit } = req.query;
    const actor = actorFrom(req);
    const filters = { type, period, startDate, endDate, machineId, poste, createdBy, search, sort, page, limit };

    // `statistics` = cartes KPI globales (Total/PROBAR/PROMESH/semaine/mois),
    // volontairement indépendantes des filtres période/machine/poste — SAUF
    // "Created by", désormais pris en compte (§11) — voir getStatistics().
    // `productionTotals` = nouveaux KPI industriels (Quantité/Diamètre/Taille
    // de maille), eux CONNECTÉS à TOUS les filtres du tableau — voir
    // getProductionTotals(). Les deux se recalculent à chaque appel, donc à
    // chaque changement de filtre côté Flutter (même requête déjà existante).
    const [{ data, pagination }, statistics, productionTotals] = await Promise.all([
      svc.listRecords(filters, actor),
      svc.getStatistics(filters, actor),
      svc.getProductionTotals(filters, actor),
    ]);

    res.json({ success: true, data, pagination, statistics, productionTotals });
  } catch (err) {
    handle(res, err);
  }
}

async function filters(req, res) {
  try {
    const data = await svc.getFilters(actorFrom(req));
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// §MODIFICATION — ADMIN > PRODUCTION RECORDS — FILTRE PAR UTILISATEUR (§3) :
// alimente le dropdown "All users" — jamais codé en dur côté Flutter.
async function creators(req, res) {
  try {
    const data = await svc.getCreators(actorFrom(req));
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// "Production Summary" — une ligne par fiche (même jeu de données que
// "Production records"), voir getProductionSummary().
async function summary(req, res) {
  try {
    const { type, period, startDate, endDate, machineId, poste, createdBy, diameter, status } = req.query;
    const filters = { type, period, startDate, endDate, machineId, poste, createdBy, diameter, status };
    const data = await svc.getProductionSummary(filters, actorFrom(req));
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function getById(req, res) {
  try {
    const data = await svc.getRecordById(req.params.id, actorFrom(req));
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = { list, filters, summary, creators, getById };
