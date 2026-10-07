"use strict";

// DASHBOARD PRODUCTION — GET /production-records/dashboard.
//
// UNE requête HTTP pour tout l'écran (KPI, cartes PROMESH / PROBAR, machines,
// graphiques, dernières productions) : quatre agrégations PostgreSQL, jamais
// une requête par carte, jamais une fiche chargée pour être comptée en JS.
// LECTURE SEULE sur les tables existantes — aucune donnée créée ni modifiée :
//   por_promesh                              fiches PROMESH (quantité en m²)
//   industrial_records (module = 'probar')   fiches PROBAR  (quantité en m)
//   recuperable_fiches                       déchets (« waste », en kg)
//
// Règles (identiques à « Production Summary », pour que les chiffres
// concordent d'un écran à l'autre) :
// - portée : responsable_logistique_achat ne voit que SES fiches ; les autres
//   rôles autorisés voient tout (même règle que productionRecords.service) ;
// - statut : archivée (status ARCHIVED / archivee), validée (VALIDE /
//   validee), sinon brouillon ;
// - quantité produite = somme des fiches VALIDÉES (un brouillon n'est pas une
//   production confirmée) ;
// - déchets = SUM(recuperable_fiches.waste) de la ligne (et de la machine),
//   sur les mêmes dates ;
// - taux de déchets = déchets / quantité × 100. Les unités diffèrent (kg et
//   m² ou m) : c'est un ratio « kg pour 100 m² » (ou « pour 100 m »), exposé
//   avec son unité — jamais présenté comme un pourcentage. null si la
//   quantité est 0 (aucune division par zéro, aucune valeur inventée).

const { QueryTypes } = require("sequelize");
const { sequelize } = require("../../../db");
const qcConfig = require("../../../config/qualityControl");
const { computeDateRange } = require("../utils/dateRange");

const RECENT_LIMIT = 10;
const PERIODS = ["today", "week", "month", "year", "custom", "all"];

// Lignes et machines : celles du module Production (même source que le
// Contrôle Qualité — Machine 1..4), jamais une machine inventée.
const LINES = Object.freeze([
  { type: "promesh", label: "PROMESH", unit: "m²", module: "PROMESH" },
  { type: "probar", label: "PROBAR", unit: "m", module: "PROBAR" },
]);
const machinesOf = (label) => qcConfig.productionLines.find((l) => l.type === label)?.machines || [];

// Fiches des deux lignes, ramenées à une forme commune. `statut` normalisé.
const FICHES_SQL = `
  SELECT 'promesh' AS type, id, machine::text AS machine, poste::text AS poste, "dateProduction" AS date, "productionM2" AS quantite,
         CASE WHEN status::text = 'ARCHIVED' THEN 'archivee' WHEN status::text = 'VALIDE' THEN 'validee' ELSE 'brouillon' END AS statut,
         "sequenceNumber" AS seq, "createdBy", "createdAt"
    FROM por_promesh
  UNION ALL
  SELECT 'probar', id, machine::text, poste::text, "dateFiche", "quantiteProduite",
         CASE WHEN statut::text = 'archivee' THEN 'archivee' WHEN statut::text = 'validee' THEN 'validee' ELSE 'brouillon' END,
         NULL::int, "createdBy", "createdAt"
    FROM industrial_records
   WHERE module = 'probar'`;

function isOwnerScoped(role) {
  return role === "responsable_logistique_achat";
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => Math.round(v * 100) / 100;

// Bornes de la période : [start, end) en dates calendaires. « all » : aucune.
function resolvePeriod(query) {
  const period = PERIODS.includes(query.period) ? query.period : "month";
  if (period === "custom") {
    const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !Number.isNaN(new Date(v).getTime());
    if (!valid(query.startDate) || !valid(query.endDate)) {
      throw { status: 400, message: "Période personnalisée : dates de début et de fin requises (AAAA-MM-JJ)" };
    }
    if (query.startDate > query.endDate) throw { status: 400, message: "La date de début doit précéder la date de fin" };
  }
  const range = computeDateRange(period, query);
  if (!range) return { period, start: null, endExclusive: null, end: null };
  const last = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() - 1);
  return { period, start: iso(range.start), endExclusive: iso(range.end), end: iso(last) };
}

function emptyLine(line) {
  return { type: line.type, label: line.label, unit: line.unit, wasteUnit: "kg", fiches: 0, validees: 0, brouillons: 0, archivees: 0, quantite: 0, dechets: 0, tauxDechets: null, tauxDechetsUnit: `kg / 100 ${line.unit}` };
}

// kg de déchets pour 100 unités produites — null sans production validée.
const wasteRate = (dechets, quantite) => (quantite > 0 ? round2((dechets / quantite) * 100) : null);

function ficheNumero(row) {
  const year = new Date(row.createdAt).getFullYear();
  if (row.type === "promesh") return row.seq == null ? null : `PROMESH-${year}-${String(row.seq).padStart(6, "0")}`;
  return `PROBAR-${year}-${String(row.id).replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

async function getDashboard(query, actor) {
  const p = resolvePeriod(query);
  const scoped = isOwnerScoped(actor.role);
  const replacements = { start: p.start, end: p.endExclusive, uid: actor.id, today: iso(new Date()), limit: RECENT_LIMIT };
  const select = { replacements, type: QueryTypes.SELECT };
  const scope = scoped ? `AND f."createdBy" = :uid` : "";
  const range = p.start ? `AND f.date >= CAST(:start AS date) AND f.date < CAST(:end AS date)` : "";
  const wasteWhere = `waste IS NOT NULL ${scoped ? `AND "createdBy" = :uid` : ""} ${p.start ? `AND date >= CAST(:start AS date) AND date < CAST(:end AS date)` : ""}`;

  const [byMachine, daily, waste, recent, today] = await Promise.all([
    // 1. Fiches par ligne et machine : volumes, statuts, dernière production.
    sequelize.query(
      `WITH f AS (${FICHES_SQL})
       SELECT f.type, f.machine,
              COUNT(*)::int AS fiches,
              COUNT(*) FILTER (WHERE f.statut = 'validee')::int AS validees,
              COUNT(*) FILTER (WHERE f.statut = 'brouillon')::int AS brouillons,
              COUNT(*) FILTER (WHERE f.statut = 'archivee')::int AS archivees,
              COALESCE(SUM(f.quantite) FILTER (WHERE f.statut = 'validee'), 0)::float AS quantite,
              to_char(MAX(f.date), 'YYYY-MM-DD') AS "lastDate",
              (ARRAY_AGG(f.statut ORDER BY f.date DESC NULLS LAST, f."createdAt" DESC))[1] AS "lastStatut"
         FROM f
        WHERE TRUE ${scope} ${range}
        GROUP BY 1, 2`,
      select
    ),
    // 2. Production validée par jour et par ligne (graphiques).
    sequelize.query(
      `WITH f AS (${FICHES_SQL})
       SELECT to_char(f.date, 'YYYY-MM-DD') AS date, f.type,
              COUNT(*)::int AS fiches,
              COALESCE(SUM(f.quantite) FILTER (WHERE f.statut = 'validee'), 0)::float AS quantite
         FROM f
        WHERE f.date IS NOT NULL ${scope} ${range}
        GROUP BY 1, 2
        ORDER BY 1`,
      select
    ),
    // 3. Déchets par ligne, machine et jour.
    sequelize.query(
      `SELECT module::text AS module, machine::text AS machine, to_char(date, 'YYYY-MM-DD') AS date, SUM(waste)::float AS dechets
         FROM recuperable_fiches
        WHERE ${wasteWhere}
        GROUP BY 1, 2, 3`,
      select
    ),
    // 4. Dernières productions (les deux lignes confondues).
    sequelize.query(
      `WITH f AS (${FICHES_SQL})
       SELECT f.type, f.id, f.machine, f.poste, to_char(f.date, 'YYYY-MM-DD') AS date, f.quantite::float AS quantite,
              f.statut, f.seq, f."createdAt", u.email AS "userEmail",
              (SELECT SUM(r.waste)::float FROM recuperable_fiches r
                WHERE r.module::text = UPPER(f.type) AND r.machine::text = f.machine AND r.date = f.date) AS dechets
         FROM f
         LEFT JOIN users u ON u.id = f."createdBy"
        WHERE TRUE ${scope} ${range}
        ORDER BY f.date DESC NULLS LAST, f."createdAt" DESC
        LIMIT :limit`,
      select
    ),
    // Productions du jour : indépendant de la période choisie.
    sequelize.query(`WITH f AS (${FICHES_SQL}) SELECT COUNT(*)::int AS n FROM f WHERE f.date = CAST(:today AS date) ${scope}`, select),
  ]);

  const wasteOf = (module, machine) => waste.filter((w) => w.module === module && (machine == null || String(w.machine) === String(machine))).reduce((s, w) => s + num(w.dechets), 0);

  const lines = {};
  let machinesActives = 0;
  let machinesTotal = 0;
  for (const line of LINES) {
    const rows = byMachine.filter((r) => r.type === line.type);
    const total = emptyLine(line);
    for (const r of rows) {
      total.fiches += r.fiches;
      total.validees += r.validees;
      total.brouillons += r.brouillons;
      total.archivees += r.archivees;
      total.quantite += num(r.quantite);
    }
    total.quantite = round2(total.quantite);
    total.dechets = round2(wasteOf(line.module));
    total.tauxDechets = wasteRate(total.dechets, total.quantite);

    // Machines de la configuration, puis toute machine présente dans les
    // données qui n'y figurerait pas (jamais masquée, jamais inventée).
    const known = machinesOf(line.label);
    const extra = rows.map((r) => r.machine).filter((m) => m != null && !known.includes(String(m)));
    const machines = [...known, ...[...new Set(extra.map(String))].sort()].map((machine) => {
      const r = rows.find((x) => String(x.machine) === String(machine));
      const quantite = round2(num(r?.quantite));
      const dechets = round2(wasteOf(line.module, machine));
      return {
        machine: String(machine),
        label: `Machine ${machine}`,
        fiches: r?.fiches || 0,
        validees: r?.validees || 0,
        brouillons: r?.brouillons || 0,
        archivees: r?.archivees || 0,
        quantite,
        dechets,
        tauxDechets: wasteRate(dechets, quantite),
        lastDate: r?.lastDate || null,
        lastStatut: r?.lastStatut || null,
        // Active : au moins une fiche sur la période.
        active: (r?.fiches || 0) > 0,
      };
    });
    machinesActives += machines.filter((m) => m.active).length;
    machinesTotal += machines.length;
    lines[line.type] = { ...total, machines };
  }

  // Séries journalières : une entrée par jour ayant des fiches ou des déchets.
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date, promesh: 0, probar: 0, fichesPromesh: 0, fichesProbar: 0, dechetsPromesh: 0, dechetsProbar: 0 });
    return days.get(date);
  };
  for (const r of daily) {
    const d = day(r.date);
    d[r.type] = round2(num(r.quantite));
    d[r.type === "promesh" ? "fichesPromesh" : "fichesProbar"] = r.fiches;
  }
  for (const w of waste) {
    const d = day(w.date);
    const key = w.module === "PROMESH" ? "dechetsPromesh" : "dechetsProbar";
    d[key] = round2(d[key] + num(w.dechets));
  }

  return {
    generatedAt: new Date().toISOString(),
    period: { key: p.period, start: p.start, end: p.end },
    scope: scoped ? "own" : "all",
    promesh: lines.promesh,
    probar: lines.probar,
    production: {
      fiches: lines.promesh.fiches + lines.probar.fiches,
      validees: lines.promesh.validees + lines.probar.validees,
      brouillons: lines.promesh.brouillons + lines.probar.brouillons,
      archivees: lines.promesh.archivees + lines.probar.archivees,
      today: today[0]?.n || 0,
    },
    machines: { actives: machinesActives, total: machinesTotal },
    waste: { promesh: lines.promesh.dechets, probar: lines.probar.dechets, total: round2(lines.promesh.dechets + lines.probar.dechets), unit: "kg" },
    charts: { daily: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) },
    recent: recent.map((r) => {
      const line = LINES.find((l) => l.type === r.type);
      return {
        id: `${r.type}:${r.id}`,
        type: r.type,
        ligne: line.label,
        numero: ficheNumero(r),
        date: r.date,
        machine: r.machine == null ? null : String(r.machine),
        poste: r.poste,
        userEmail: r.userEmail || null,
        quantite: r.quantite == null ? null : round2(num(r.quantite)),
        quantiteUnite: line.unit,
        dechets: r.dechets == null ? null : round2(num(r.dechets)),
        dechetsUnite: "kg",
        statut: r.statut,
      };
    }),
  };
}

module.exports = { getDashboard, resolvePeriod, PERIODS };
