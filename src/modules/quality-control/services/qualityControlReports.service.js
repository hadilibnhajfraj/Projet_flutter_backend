"use strict";

// Module CONTRÔLE QUALITÉ — données des EXPORTS de l'Historique. (La
// comparaison entre deux périodes : qualityControlComparison.service.)
//
// Source unique : PostgreSQL, filtré par EXACTEMENT la même fonction que la
// liste de l'Historique (qualityControl.service#buildListWhere — portée
// controle_qualite, ligne, machine, résultat, période, recherche). Mêmes
// règles de calcul partout :
// - BROUILLON (non validé) = « À vérifier », jamais Conforme / Non conforme ;
// - Conformes / Non conformes = fiches VALIDÉES selon leur résultat ;
// - taux = conformes (ou non conformes) / fiches validées × 100, null s'il
//   n'y a aucune fiche validée (jamais NaN / Infinity) ;
// - évolution relative = (B − A) / A × 100, null si A = 0 ; les taux
//   évoluent en POINTS (B − A).

const dayjs = require("dayjs");

const cfg = require("../../../config/qualityControl");
const QualityControl = require("../../../models/QualityControl");
const qc = require("./qualityControl.service");

// Garde-fou volume (export) : au-delà, l'utilisateur doit filtrer.
const MAX_EXPORT_ROWS = 10000;
const PARAM_LABELS = new Map(cfg.parameters.map((p) => [p.key, p.label]));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(code, message) {
  return { status: 400, code, message };
}

function isoDate(value, label) {
  const v = String(value || "").trim();
  if (!ISO_DATE.test(v) || !dayjs(v, "YYYY-MM-DD").isValid() || dayjs(v).format("YYYY-MM-DD") !== v) {
    throw badRequest("INVALID_DATE", `${label} : date invalide (AAAA-MM-JJ attendu)`);
  }
  return v;
}

// Filtres acceptés (mêmes noms que GET /quality-control).
function pickFilters(q = {}) {
  const f = {};
  for (const k of ["status", "productionType", "machine", "from", "to", "period", "search"]) {
    if (q[k] != null && String(q[k]).trim() !== "") f[k] = String(q[k]).trim();
  }
  if (f.productionType) f.productionType = f.productionType.toUpperCase();
  if (f.from) isoDate(f.from, "Date de début");
  if (f.to) isoDate(f.to, "Date de fin");
  if (f.from && f.to && f.from > f.to) throw badRequest("INVALID_RANGE", "La date de début doit précéder la date de fin");
  return f;
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 100 : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// ── Lecture : fiches (filtrées) + paramètres ─────────────────────────────

async function loadControls(filters, actor) {
  const where = qc.buildListWhere(filters, actor);
  const count = await QualityControl.count({ where });
  if (count > MAX_EXPORT_ROWS) {
    throw badRequest("TOO_MANY_ROWS", `${count} contrôles correspondent : affinez les filtres (maximum ${MAX_EXPORT_ROWS})`);
  }
  const rows = await QualityControl.findAll({ where, order: qc.EFFECTIVE_ORDER });
  if (!rows.length) return [];
  // Prélèvements de chaque fiche avec leurs paramètres (détail).
  const entries = await qc.loadEntriesFor(rows.map((r) => r.id));
  return rows.map((r) => {
    const c = qc.toControlResponse(r, entries.get(r.id) || [], { history: [] });
    delete c.history;
    return c;
  });
}

// ── KPI ──────────────────────────────────────────────────────────────────

function emptyBucket() {
  // `releves` : compté à part — une fiche à 3 prélèvements reste UN contrôle.
  return { total: 0, releves: 0, conformes: 0, nonConformes: 0, aVerifier: 0, valides: 0, parametresControles: 0, parametresNonConformes: 0 };
}

function add(bucket, c) {
  bucket.total += 1;
  bucket.releves += c.readingsCount || 0;
  if (c.isValidated) {
    bucket.valides += 1;
    if (c.status === qc.STATUS.CONFORME) bucket.conformes += 1;
    else if (c.status === qc.STATUS.NON_CONFORME) bucket.nonConformes += 1;
  } else {
    bucket.aVerifier += 1;
  }
  bucket.parametresControles += c.counts?.controlled || 0;
  bucket.parametresNonConformes += c.counts?.nonConformes || 0;
}

function finalize(b) {
  return {
    ...b,
    tauxConformite: pct(b.conformes, b.valides),
    tauxNonConformite: pct(b.nonConformes, b.valides),
    moyenneParametresNonConformes: b.total > 0 ? round2(b.parametresNonConformes / b.total) : null,
  };
}

// Lignes / machines affichées : celles de la configuration (filtrées).
function targetLines(filters) {
  return cfg.productionLines
    .filter((l) => !filters.productionType || l.type === filters.productionType)
    .map((l) => ({ ...l, machines: l.machines.filter((m) => !filters.machine || m === String(filters.machine)) }));
}

function summarize(controls, filters) {
  const totals = emptyBucket();
  const lines = targetLines(filters);
  const byType = new Map(lines.map((l) => [l.type, emptyBucket()]));
  const byMachine = new Map();
  for (const l of lines) for (const m of l.machines) byMachine.set(`${l.type}:${m}`, emptyBucket());
  // Analyse par paramètre : contrôles des prélèvements (les paramètres physiques
  // de la fiche ne portent pas de statut).
  const byParameter = new Map(cfg.readingParameters.map((p) => [p.key, { controles: 0, nonConformes: 0 }]));

  for (const c of controls) {
    add(totals, c);
    if (byType.has(c.productionType)) add(byType.get(c.productionType), c);
    const key = `${c.productionType}:${c.machine}`;
    if (byMachine.has(key)) add(byMachine.get(key), c);
    // Paramètres analysés PAR PRÉLÈVEMENT.
    for (const r of c.readings || []) {
      for (const i of r.items || []) {
        const p = byParameter.get(i.parameterKey);
        if (!p) continue;
        if (i.status !== qc.ITEM_STATUS.NON_CONTROLE) p.controles += 1;
        if (i.status === qc.ITEM_STATUS.NON_CONFORME) p.nonConformes += 1;
      }
    }
  }

  return {
    totals: finalize(totals),
    byType: lines.map((l) => ({ type: l.type, label: l.label, ...finalize(byType.get(l.type)) })),
    byMachine: lines.flatMap((l) =>
      l.machines.map((m) => ({ type: l.type, machine: m, label: `${l.label} · Machine ${m}`, ...finalize(byMachine.get(`${l.type}:${m}`)) }))
    ),
    byParameter: cfg.readingParameters.map((p) => ({ key: p.key, label: p.label, ...byParameter.get(p.key) })),
  };
}

// ── Export (Historique) ──────────────────────────────────────────────────

async function exportData(query, actor) {
  const filters = pickFilters(query);
  const controls = await loadControls(filters, actor);
  return { filters, controls, summary: summarize(controls, filters), actor, generatedAt: new Date() };
}

module.exports = { exportData, pickFilters, summarize, MAX_EXPORT_ROWS, PARAM_LABELS };
