"use strict";

// Agrégation en mémoire (comptages/sommes) sur des volumes par poste/jour
// qui restent petits — même approche que porPromesh.service.getDashboard,
// pas de nouvelle dépendance de reporting.

const IndustrialRecord = require("../../../models/IndustrialRecord");
const PorPromesh = require("../../../models/PorPromesh");
const HrRequest = require("../../../models/HrRequest");
const RecuperableFiche = require("../../../models/RecuperableFiche");
const RecuperableLigne = require("../../../models/RecuperableLigne");
require("../../../models/associations");

function dateBounds() {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const today = startOfDay(now);
  const weekday = today.getDay() === 0 ? 7 : today.getDay(); // lundi = 1
  return {
    today,
    tomorrow: addDays(today, 1),
    startOfWeek: addDays(today, -(weekday - 1)),
    startOfMonth: new Date(today.getFullYear(), today.getMonth(), 1),
  };
}

function bucketCounts(rows, dateField, bounds) {
  let today = 0;
  let week = 0;
  let month = 0;
  for (const r of rows) {
    const raw = r[dateField];
    if (!raw) continue;
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    if (d >= bounds.today && d < bounds.tomorrow) today += 1;
    if (d >= bounds.startOfWeek && d < bounds.tomorrow) week += 1;
    if (d >= bounds.startOfMonth && d < bounds.tomorrow) month += 1;
  }
  return { today, week, month };
}

function countBy(rows, field) {
  const out = {};
  for (const r of rows) {
    const key = r[field] || "—";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function latestOf(rows, limit = 5) {
  return [...rows]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

// ── PROMESH ────────────────────────────────────────────────────────────

async function getPromeshStats(bounds) {
  const rows = await PorPromesh.findAll({
    attributes: ["id", "sequenceNumber", "machine", "poste", "productionM2", "status", "operateur", "createdAt"],
    order: [["createdAt", "DESC"]],
    raw: true,
  });

  const machines = new Set(rows.map((r) => r.machine).filter(Boolean));

  return {
    fichesCount: rows.length,
    ...bucketCounts(rows, "createdAt", bounds),
    machinesActives: machines.size,
    repartitionParMachine: countBy(rows, "machine"),
    repartitionParPoste: countBy(rows, "poste"),
    dernieresFiches: latestOf(rows).map((r) => ({
      id: r.id,
      reference: r.sequenceNumber,
      machine: r.machine,
      poste: r.poste,
      statut: r.status,
      operateur: r.operateur,
      createdAt: r.createdAt,
    })),
  };
}

// ── PROBAR ─────────────────────────────────────────────────────────────

async function getProbarStats(bounds) {
  const rows = await IndustrialRecord.findAll({
    where: { module: "probar" },
    attributes: ["id", "machine", "poste", "quantiteProduite", "statut", "operateur", "createdAt"],
    order: [["createdAt", "DESC"]],
    raw: true,
  });

  const machines = new Set(rows.map((r) => r.machine).filter(Boolean));

  return {
    fichesCount: rows.length,
    ...bucketCounts(rows, "createdAt", bounds),
    machinesActives: machines.size,
    repartitionParMachine: countBy(rows, "machine"),
    repartitionParPoste: countBy(rows, "poste"),
    dernieresFiches: latestOf(rows).map((r) => ({
      id: r.id,
      machine: r.machine,
      poste: r.poste,
      statut: r.statut,
      operateur: r.operateur,
      createdAt: r.createdAt,
    })),
  };
}

// ── Maintenance ────────────────────────────────────────────────────────

async function getMaintenanceStats() {
  const rows = await IndustrialRecord.findAll({
    where: { module: "maintenance" },
    attributes: ["id", "machine", "urgence", "statut", "typePanne", "createdAt"],
    order: [["createdAt", "DESC"]],
    raw: true,
  });

  const terminees = rows.filter((r) => r.statut && r.statut !== "ouverte").length;

  return {
    demandesOuvertes: rows.length - terminees,
    demandesTerminees: terminees,
    urgentes: rows.filter((r) => r.urgence === "critique").length,
    enAttente: rows.filter((r) => r.statut === "en_attente").length,
    dernieresDemandes: latestOf(rows).map((r) => ({
      id: r.id,
      machine: r.machine,
      urgence: r.urgence,
      statut: r.statut,
      typePanne: r.typePanne,
      createdAt: r.createdAt,
    })),
  };
}

// ── RH ─────────────────────────────────────────────────────────────────

async function getRhStats() {
  const rows = await HrRequest.findAll({
    attributes: ["id", "type", "statut", "employeeNom", "employeePrenom", "createdAt"],
    order: [["createdAt", "DESC"]],
    raw: true,
  });

  const conges = rows.filter((r) => r.type === "conge").length;
  const sorties = rows.filter((r) => r.type === "sortie").length;

  return {
    demandesConge: conges,
    autorisationsSortie: sorties,
    acceptees: rows.filter((r) => r.statut === "acceptee").length,
    refusees: rows.filter((r) => r.statut === "refusee").length,
    enAttente: rows.filter((r) => r.statut === "en_attente").length,
    dernieresDemandes: latestOf(rows).map((r) => ({
      id: r.id,
      type: r.type,
      statut: r.statut,
      employe: [r.employeeNom, r.employeePrenom].filter(Boolean).join(" "),
      createdAt: r.createdAt,
    })),
  };
}

// ── Mélange ────────────────────────────────────────────────────────────

async function getMelangeStats() {
  const rows = await IndustrialRecord.findAll({
    where: { module: "melange" },
    attributes: ["id", "machine", "quantiteProduite", "createdAt"],
    order: [["createdAt", "DESC"]],
    raw: true,
  });

  const productionTotale = rows.reduce((sum, r) => sum + (Number(r.quantiteProduite) || 0), 0);

  return {
    fichesCount: rows.length,
    productionTotale,
    dernieresFiches: latestOf(rows).map((r) => ({
      id: r.id,
      machine: r.machine,
      quantiteProduite: r.quantiteProduite,
      createdAt: r.createdAt,
    })),
  };
}

// ── Récupérables ───────────────────────────────────────────────────────

async function getRecuperablesStats() {
  const fiches = await RecuperableFiche.count();
  const lignes = await RecuperableLigne.findAll({
    attributes: ["dechetKg", "dechetProduitFiniKg"],
    raw: true,
  });

  const dechetsKg = lignes.reduce((sum, l) => sum + (Number(l.dechetKg) || 0), 0);
  const produitFiniKg = lignes.reduce((sum, l) => sum + (Number(l.dechetProduitFiniKg) || 0), 0);

  return {
    fichesCount: fiches,
    dechetsKg,
    produitFiniKg,
    totalRecupereKg: dechetsKg + produitFiniKg,
  };
}

// ── Combiné ────────────────────────────────────────────────────────────

async function getFullDashboard() {
  const bounds = dateBounds();

  const [promesh, probar, maintenance, rh, melange, recuperables] = await Promise.all([
    getPromeshStats(bounds),
    getProbarStats(bounds),
    getMaintenanceStats(),
    getRhStats(),
    getMelangeStats(),
    getRecuperablesStats(),
  ]);

  return { promesh, probar, maintenance, rh, melange, recuperables };
}

module.exports = { getFullDashboard };
