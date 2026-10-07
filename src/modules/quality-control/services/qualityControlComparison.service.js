"use strict";

// Module CONTRÔLE QUALITÉ — COMPARAISON QUALITÉ période A / période B.
//
// Entièrement pilotée par les données : KPI, classements, paramètres, points
// d'attention et phrases d'analyse sont CALCULÉS à partir des fiches de la
// base — aucun chiffre, aucune machine, aucun paramètre, aucun texte n'est
// fourni par défaut. Quand les données ne permettent pas une conclusion, la
// réponse le dit (`dataStatus`) au lieu d'afficher une variation.
//
// Agrégations faites par PostgreSQL (COUNT … FILTER, GROUP BY) en trois
// requêtes, quelles que soient les périodes — jamais une fiche chargée en
// mémoire :
//   1. fiches par période / ligne / machine / poste / jour ;
//   2. paramètres (contrôlés, non conformes) par période / ligne / paramètre ;
//   3. contrôleurs disponibles pour le filtre.
//
// Mêmes règles que l'Historique et le tableau de bord :
// - portée : fiches des comptes controle_qualite (le rôle ne voit que les
//   siennes) ; date = date EFFECTIVE du contrôle (ouverture) ;
// - BROUILLON = « à vérifier » ; conformes / non conformes = fiches VALIDÉES ;
// - taux = part des fiches validées (null s'il n'y en a aucune) ; un taux
//   évolue en POINTS, un nombre en valeur et en % (null si la base est 0) ;
// - PROMESH ≠ PROBAR : chaque ligne n'expose que SES paramètres ; entre lignes
//   seuls les KPI communs sont comparés.

const { QueryTypes } = require("sequelize");
const dayjs = require("dayjs");

const { sequelize } = require("../../../db");
const cfg = require("../../../config/qualityControl");
const qc = require("./qualityControl.service");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Une seule fiche sur une période : chiffres donnés, mais signalés comme
// « données limitées » (pas une tendance fiable).
const LIMITED_BELOW = 2;
const POSTES = Object.freeze([
  { poste: "matin", label: "Matin" },
  { poste: "soir", label: "Soir" },
]);
const RESULTS = Object.freeze({
  CONFORME: `AND "validatedAt" IS NOT NULL AND status = 'CONFORME'`,
  NON_CONFORME: `AND "validatedAt" IS NOT NULL AND status = 'NON_CONFORME'`,
  // Brouillon = à vérifier (une fiche non validée n'a pas encore de résultat).
  A_VERIFIER: `AND "validatedAt" IS NULL`,
  BROUILLON: `AND "validatedAt" IS NULL`,
});

function badRequest(code, message) {
  return { status: 400, code, message };
}

function isoDate(value, label) {
  const v = String(value || "").trim();
  if (!ISO_DATE.test(v) || dayjs(v).format("YYYY-MM-DD") !== v) throw badRequest("INVALID_DATE", `${label} : date invalide (AAAA-MM-JJ attendu)`);
  return v;
}

function parsePeriod(q, key, label) {
  const start = isoDate(q[`${key}Start`], `${label} — début`);
  const end = isoDate(q[`${key}End`], `${label} — fin`);
  if (start > end) throw badRequest("INVALID_RANGE", `${label} : la date de début doit précéder la date de fin`);
  return { start, end };
}

const text = (v) => (v == null || String(v).trim() === "" || String(v).trim().toLowerCase() === "all" ? null : String(v).trim());

// Filtres appliqués aux DEUX périodes. Ligne et machine : celles de la
// configuration ; une machine n'est proposée que pour la ligne choisie.
function parseFilters(q) {
  const productionType = text(q.productionType || q.type)?.toUpperCase() || null;
  if (productionType && !cfg.productionLines.some((l) => l.type === productionType)) {
    throw badRequest("INVALID_PRODUCTION_TYPE", "Ligne invalide (PROMESH ou PROBAR attendu)");
  }
  const machine = text(q.machine || q.machineId);
  const lines = cfg.productionLines.filter((l) => !productionType || l.type === productionType);
  if (machine && !lines.some((l) => l.machines.includes(machine))) throw badRequest("INVALID_MACHINE", `Machine inconnue : ${machine}`);
  const poste = text(q.poste || q.shift)?.toLowerCase() || null;
  if (poste && !cfg.postes.includes(poste)) throw badRequest("INVALID_POSTE", "Poste invalide (matin ou soir attendu)");
  const controller = text(q.controller || q.controllerId);
  if (controller && !UUID_RE.test(controller)) throw badRequest("INVALID_CONTROLLER", "Contrôleur invalide");
  const result = text(q.result || q.resultat)?.toUpperCase() || null;
  if (result && !RESULTS[result]) throw badRequest("INVALID_RESULT", "Résultat invalide (CONFORME, NON_CONFORME, A_VERIFIER)");
  return { productionType, machine, poste, controller, result: result === "BROUILLON" ? "A_VERIFIER" : result };
}

// ── KPI ──────────────────────────────────────────────────────────────────

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const pct = (n, d) => (d > 0 ? round2((n / d) * 100) : null);

function bucket() {
  return { total: 0, releves: 0, conformes: 0, nonConformes: 0, aVerifier: 0, valides: 0, parametresControles: 0, parametresNonConformes: 0, machines: new Set() };
}

function addRow(b, r) {
  b.total += r.total;
  b.releves += r.releves;
  b.conformes += r.conformes;
  b.nonConformes += r.nonConformes;
  b.aVerifier += r.aVerifier;
  b.valides += r.conformes + r.nonConformes;
  b.machines.add(`${r.type}:${r.machine}`);
}

// Niveau de données d'une période : aucune, limitée (une seule fiche), ok.
const dataLevel = (total) => (total === 0 ? "none" : total < LIMITED_BELOW ? "limited" : "ok");

function finalize(b) {
  const { machines, ...counts } = b;
  return {
    ...counts,
    machinesControlees: machines.size,
    tauxConformite: pct(b.conformes, b.valides),
    tauxNonConformite: pct(b.nonConformes, b.valides),
    moyenneParametresControles: b.total > 0 ? round2(b.parametresControles / b.total) : null,
    moyenneParametresNonConformes: b.total > 0 ? round2(b.parametresNonConformes / b.total) : null,
    dataLevel: dataLevel(b.total),
  };
}

const COUNT_KPIS = ["total", "releves", "conformes", "nonConformes", "aVerifier", "parametresControles", "parametresNonConformes", "machinesControlees"];
const RATE_KPIS = ["tauxConformite", "tauxNonConformite"];
const AVG_KPIS = ["moyenneParametresControles", "moyenneParametresNonConformes"];

// Évolution B − A. Une période sans aucune fiche ne donne AUCUNE variation
// (null) : pas de « +100 % » ni de « −100 % » artificiel.
function evolution(a, b) {
  const comparable = a.total > 0 && b.total > 0;
  const out = {};
  for (const k of COUNT_KPIS) {
    out[k] = comparable ? { absolue: b[k] - a[k], relative: a[k] > 0 ? round2(((b[k] - a[k]) / a[k]) * 100) : null } : { absolue: null, relative: null };
  }
  for (const k of RATE_KPIS) out[k] = { points: comparable && a[k] != null && b[k] != null ? round2(b[k] - a[k]) : null };
  for (const k of AVG_KPIS) out[k] = { absolue: comparable && a[k] != null && b[k] != null ? round2(b[k] - a[k]) : null };
  return out;
}

// ── Requêtes ─────────────────────────────────────────────────────────────

// Fiches des deux périodes (portée + filtres), étiquetées A et/ou B. Une
// fiche d'un jour commun aux deux périodes compte dans chacune.
function baseSql(filters, actor) {
  const where = [qc.scopeSqlFor(actor)];
  if (filters.productionType) where.push(`AND "productionType" = :productionType`);
  if (filters.machine) where.push(`AND machine = :machine`);
  // « nuit » : ancienne valeur du poste du soir (comptée avec lui).
  if (filters.poste) where.push(filters.poste === "soir" ? `AND poste IN ('soir', 'nuit')` : `AND poste = :poste`);
  if (filters.controller) where.push(`AND "controllerUserId" = :controller`);
  if (filters.result) where.push(RESULTS[filters.result]);
  const ts = qc.EFFECTIVE_TS_SQL;
  return `
    WITH base AS (
      SELECT id, "productionType" AS type, machine, poste, status,
             ("validatedAt" IS NOT NULL) AS validated,
             CAST(${ts} AS date) AS day
        FROM quality_controls
       WHERE "deletedAt" IS NULL ${where.join(" ")}
         AND ${ts} >= CAST(:minStart AS date) AND ${ts} < CAST(:maxEnd AS date) + 1
    ), tagged AS (
      SELECT base.*,
             (day BETWEEN CAST(:aStart AS date) AND CAST(:aEnd AS date)) AS in_a,
             (day BETWEEN CAST(:bStart AS date) AND CAST(:bEnd AS date)) AS in_b
        FROM base
    )`;
}

const PERIODS_SQL = `CROSS JOIN LATERAL (VALUES ('A', t.in_a), ('B', t.in_b)) AS p(period, hit)`;

async function runQueries(periodA, periodB, filters, actor) {
  const replacements = {
    uid: actor.id,
    aStart: periodA.start,
    aEnd: periodA.end,
    bStart: periodB.start,
    bEnd: periodB.end,
    minStart: periodA.start < periodB.start ? periodA.start : periodB.start,
    maxEnd: periodA.end > periodB.end ? periodA.end : periodB.end,
    productionType: filters.productionType,
    machine: filters.machine,
    poste: filters.poste,
    controller: filters.controller,
  };
  const base = baseSql(filters, actor);
  const options = { replacements, type: QueryTypes.SELECT };
  const [controls, parameters, controllers] = await Promise.all([
    sequelize.query(
      `${base}
       SELECT p.period, t.type, t.machine, t.poste, to_char(t.day, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE t.validated AND t.status = 'CONFORME')::int AS conformes,
              COUNT(*) FILTER (WHERE t.validated AND t.status = 'NON_CONFORME')::int AS "nonConformes",
              COUNT(*) FILTER (WHERE NOT t.validated)::int AS "aVerifier",
              COALESCE(SUM((SELECT COUNT(*) FROM quality_control_readings r WHERE r."qualityControlId" = t.id)), 0)::int AS releves
         FROM tagged t ${PERIODS_SQL}
        WHERE p.hit
        GROUP BY 1, 2, 3, 4, 5`,
      options
    ),
    // Paramètres portant un statut : contrôles des prélèvements + contrôle
    // spécifique de la fiche (treillis GFRP).
    sequelize.query(
      `${base}
       SELECT p.period, t.type, i."parameterKey" AS key,
              COUNT(*)::int AS controles,
              COUNT(*) FILTER (WHERE i.status = 'NON_CONFORME')::int AS "nonConformes"
         FROM tagged t
         JOIN quality_control_items i ON i."qualityControlId" = t.id AND i.status <> 'NON_CONTROLE'
         ${PERIODS_SQL}
        WHERE p.hit
        GROUP BY 1, 2, 3`,
      options
    ),
    // Contrôleurs proposés par le filtre : ceux qui ont réellement des fiches.
    sequelize.query(
      `SELECT DISTINCT "controllerUserId" AS id, "controllerEmail" AS email
         FROM quality_controls
        WHERE "deletedAt" IS NULL ${qc.scopeSqlFor(actor)} AND "controllerUserId" IS NOT NULL
        ORDER BY 2`,
      options
    ),
  ]);
  return { controls, parameters, controllers };
}

// ── Paramètres ───────────────────────────────────────────────────────────

const SECTION_LABELS = new Map(cfg.sections.map((s) => [s.key, s]));

// Paramètres d'une ligne qui portent un statut : contrôles des prélèvements +
// contrôle spécifique (treillis GFRP pour PROMESH). Jamais ceux d'une autre
// ligne.
function statusParameters(type) {
  const out = [...cfg.readingParametersFor(type), ...cfg.specificParameters(type)];
  // + paramètres propres à une machine de la ligne (PROMESH 4), sans doublon.
  for (const m of cfg.machineLines.filter((x) => x.type === type)) {
    for (const p of cfg.readingParametersFor(m.key)) if (!out.some((o) => o.key === p.key)) out.push(p);
  }
  return out;
}

const paramSide = (v) => {
  const controles = v?.controles || 0;
  const nonConformes = v?.nonConformes || 0;
  return { controles, nonConformes, tauxConformite: pct(controles - nonConformes, controles) };
};

// Une ligne par paramètre RÉELLEMENT contrôlé sur l'une des périodes, par
// ligne de production. Évolution en points, seulement s'il est contrôlé sur
// les DEUX périodes.
function parameterRows(rows, types) {
  const byKey = new Map(rows.map((r) => [`${r.period}:${r.type}:${r.key}`, r]));
  const out = [];
  for (const type of types) {
    for (const p of statusParameters(type)) {
      const a = paramSide(byKey.get(`A:${type}:${p.key}`));
      const b = paramSide(byKey.get(`B:${type}:${p.key}`));
      if (a.controles === 0 && b.controles === 0) continue;
      const section = SECTION_LABELS.get(p.section);
      out.push({
        type,
        key: p.key,
        label: p.label,
        section: p.section,
        sectionLabel: section?.label || p.section,
        // "treillis" : contrôle spécifique des treillis GFRP ; "releve" : contrôle d'un prélèvement.
        group: p.scope === "fiche" ? section?.group || "fiche" : "releve",
        periodA: a,
        periodB: b,
        evolutionPoints: a.tauxConformite != null && b.tauxConformite != null ? round2(b.tauxConformite - a.tauxConformite) : null,
        // Moins de 2 mesures sur une période : écart donné, signalé peu fiable.
        limited: a.controles > 0 && b.controles > 0 && Math.min(a.controles, b.controles) < LIMITED_BELOW,
      });
    }
  }
  return out;
}

// ── Analyse (phrases générées à partir des chiffres) ─────────────────────

const fr = (v, digits = 1) => String(Number(v).toFixed(digits)).replace(".", ",");
const pts = (v) => `${fr(Math.abs(v))} point${Math.abs(v) >= 2 ? "s" : ""}`;
const fmtDate = (iso) => dayjs(iso).format("DD/MM/YYYY");

function shiftInsight(byShift) {
  const [matin, soir] = ["matin", "soir"].map((p) => byShift.find((s) => s.poste === p)?.periodB);
  if (!matin || !soir || matin.valides < LIMITED_BELOW || soir.valides < LIMITED_BELOW) return null;
  const diff = round2(soir.tauxNonConformite - matin.tauxNonConformite);
  if (Math.abs(diff) < 1) return null;
  const [high, low] = diff > 0 ? ["Soir", "Matin"] : ["Matin", "Soir"];
  return `Le poste ${high} présente un taux de non-conformité supérieur de ${pts(diff)} au poste ${low} sur la période B.`;
}

// Catégorie de paramètres dont les non-conformités ont le plus varié dans le
// sens de l'évolution globale — seulement si la variation existe.
function sectionDriver(parameters, improving) {
  const bySection = new Map();
  for (const p of parameters) {
    const s = bySection.get(p.sectionLabel) || { label: p.sectionLabel, a: 0, b: 0 };
    s.a += p.periodA.nonConformes;
    s.b += p.periodB.nonConformes;
    bySection.set(p.sectionLabel, s);
  }
  const ranked = [...bySection.values()].map((s) => ({ ...s, delta: s.b - s.a })).filter((s) => (improving ? s.delta < 0 : s.delta > 0));
  ranked.sort((x, y) => (improving ? x.delta - y.delta : y.delta - x.delta));
  return ranked[0] || null;
}

// État des données, dit clairement (jamais de comparaison trompeuse).
function buildMessages(a, b) {
  const out = [];
  if (a.total === 0 && b.total === 0) out.push({ code: "NO_DATA", text: "Pas suffisamment de données pour cette analyse" });
  if (a.total === 0) out.push({ code: "NO_DATA_A", text: "Aucune donnée disponible pour la période A" });
  if (b.total === 0) out.push({ code: "NO_DATA_B", text: "Aucune donnée disponible pour la période B" });
  if ((a.total === 0) !== (b.total === 0)) out.push({ code: "INSUFFICIENT", text: "Comparaison impossible : données insuffisantes" });
  for (const [name, p] of [["A", a], ["B", b]]) {
    if (p.dataLevel === "limited") out.push({ code: `LIMITED_${name}`, text: `Données limitées : la période ${name} ne contient qu'un seul contrôle qualité` });
  }
  return out;
}

function buildAnalysis({ periodA: a, periodB: b, dataStatus, parameters, improvements, attentionPoints, ranking, byShift }) {
  const out = [];
  if (dataStatus === "empty") return ["Pas suffisamment de données pour cette analyse : aucun contrôle qualité sur les deux périodes."];
  if (dataStatus === "insufficient") {
    const missing = a.total === 0 ? "A" : "B";
    return [`Comparaison impossible : données insuffisantes (aucun contrôle qualité sur la période ${missing}).`];
  }
  if (dataStatus === "limited") {
    const which = [a.dataLevel === "limited" ? "A" : null, b.dataLevel === "limited" ? "B" : null].filter(Boolean).join(" et ");
    out.push(`Données limitées : la période ${which} ne contient qu'un seul contrôle qualité ; les écarts ne constituent pas une tendance fiable.`);
  }
  if (a.total !== b.total) {
    const rel = a.total > 0 ? ` (${b.total > a.total ? "+" : "−"}${fr(Math.abs(((b.total - a.total) / a.total) * 100))} %)` : "";
    out.push(`Le nombre de contrôles qualité est passé de ${a.total} à ${b.total}${rel}.`);
  } else {
    out.push(`Le nombre de contrôles qualité est identique sur les deux périodes (${a.total}).`);
  }
  if (a.tauxConformite != null && b.tauxConformite != null) {
    const diff = round2(b.tauxConformite - a.tauxConformite);
    if (diff === 0) {
      out.push(`Le taux de conformité est resté stable à ${fr(b.tauxConformite)} %.`);
    } else {
      out.push(
        `Le taux de conformité est passé de ${fr(a.tauxConformite)} % à ${fr(b.tauxConformite)} % entre les deux périodes, soit une ${diff > 0 ? "amélioration" : "baisse"} de ${pts(diff)}.`
      );
      const driver = sectionDriver(parameters, diff > 0);
      if (driver) {
        out.push(
          `${diff > 0 ? "La diminution" : "L'augmentation"} des non-conformités concerne principalement les paramètres « ${driver.label} » (${driver.a} → ${driver.b}).`
        );
      }
    }
  } else {
    out.push("Taux de conformité non calculable : aucune fiche validée sur au moins une des périodes.");
  }
  if (improvements[0]) {
    const p = improvements[0];
    out.push(`Principale amélioration : ${p.label} (${fr(p.periodA.tauxConformite)} % → ${fr(p.periodB.tauxConformite)} %, +${pts(p.evolutionPoints)}).`);
  }
  if (attentionPoints[0]) {
    const p = attentionPoints[0];
    out.push(`Principal point d'attention : ${p.label} (${fr(p.periodA.tauxConformite)} % → ${fr(p.periodB.tauxConformite)} %, −${pts(p.evolutionPoints)}).`);
  }
  if (ranking && ranking.best && ranking.worst && ranking.best.label !== ranking.worst.label) {
    out.push(`Meilleure performance sur la période B : ${ranking.best.label} (${fr(ranking.best.tauxConformite)} %) ; à surveiller : ${ranking.worst.label} (${fr(ranking.worst.tauxConformite)} %).`);
  }
  const shift = shiftInsight(byShift);
  if (shift) out.push(shift);
  return out;
}

// ── Comparaison ──────────────────────────────────────────────────────────

const controllerLabel = (email) => (String(email || "").split("@")[0] === cfg.role ? "Contrôle Qualité" : String(email || "—"));

async function comparison(query, actor) {
  const periodA = parsePeriod(query, "periodA", "Période A");
  const periodB = parsePeriod(query, "periodB", "Période B");
  const filters = parseFilters(query);
  const { controls, parameters: paramRows, controllers } = await runQueries(periodA, periodB, filters, actor);

  const lines = cfg.productionLines
    .filter((l) => !filters.productionType || l.type === filters.productionType)
    .map((l) => ({ ...l, machines: l.machines.filter((m) => !filters.machine || m === filters.machine) }));
  const types = lines.map((l) => l.type);

  // Agrégats (totaux, lignes, machines, postes, jours) à partir des groupes SQL.
  const totals = { A: bucket(), B: bucket() };
  const byType = new Map(types.map((t) => [t, { A: bucket(), B: bucket() }]));
  const byMachine = new Map();
  for (const l of lines) for (const m of l.machines) byMachine.set(`${l.type}:${m}`, { A: bucket(), B: bucket() });
  const byPoste = new Map(POSTES.map((p) => [p.poste, { A: bucket(), B: bucket() }]));
  const byDay = { A: new Map(), B: new Map() };
  for (const r of controls) {
    addRow(totals[r.period], r);
    if (byType.has(r.type)) addRow(byType.get(r.type)[r.period], r);
    const m = byMachine.get(`${r.type}:${r.machine}`);
    if (m) addRow(m[r.period], r);
    // « nuit » : ancienne valeur du poste du soir.
    const poste = byPoste.get(r.poste === "nuit" ? "soir" : r.poste);
    if (poste) addRow(poste[r.period], r);
    const day = byDay[r.period].get(r.day) || bucket();
    addRow(day, r);
    byDay[r.period].set(r.day, day);
  }
  // Paramètres contrôlés / non conformes : ceux de la LIGNE de chaque fiche.
  const allowed = new Map(types.map((t) => [t, new Set(statusParameters(t).map((p) => p.key))]));
  const kept = paramRows.filter((r) => allowed.get(r.type)?.has(r.key));
  for (const r of kept) {
    for (const b of [totals[r.period], byType.get(r.type)[r.period]]) {
      b.parametresControles += r.controles;
      b.parametresNonConformes += r.nonConformes;
    }
  }

  const a = finalize(totals.A);
  const b = finalize(totals.B);
  // none + none : vide ; une seule période alimentée : comparaison
  // impossible ; une seule fiche sur une période : données limitées.
  const dataStatus =
    a.total === 0 && b.total === 0 ? "empty" : a.total === 0 || b.total === 0 ? "insufficient" : a.dataLevel === "limited" || b.dataLevel === "limited" ? "limited" : "ok";
  const pair = (entry) => {
    const pa = finalize(entry.A);
    const pb = finalize(entry.B);
    return { periodA: pa, periodB: pb, evolution: evolution(pa, pb) };
  };

  const machineRows = lines.flatMap((l) => l.machines.map((m) => ({ type: l.type, machine: m, label: `${l.label} · Machine ${m}`, ...pair(byMachine.get(`${l.type}:${m}`)) })));
  // Classement des machines (période B, fiches validées) — seulement quand
  // plusieurs machines sont comparées ; une machine seule : son évolution.
  const ranked = machineRows
    .filter((m) => m.periodB.tauxConformite != null)
    .map((m) => ({ type: m.type, machine: m.machine, label: m.label, tauxConformite: m.periodB.tauxConformite, valides: m.periodB.valides }))
    .sort((x, y) => y.tauxConformite - x.tauxConformite || y.valides - x.valides);
  const ranking = !filters.machine && ranked.length >= 2 ? { period: "B", machines: ranked, best: ranked[0], worst: ranked[ranked.length - 1] } : null;

  const parameters = parameterRows(kept, types);
  const moved = parameters.filter((p) => p.evolutionPoints != null && p.evolutionPoints !== 0);
  const improvements = moved.filter((p) => p.evolutionPoints > 0).sort((x, y) => y.evolutionPoints - x.evolutionPoints);
  const attentionPoints = moved.filter((p) => p.evolutionPoints < 0).sort((x, y) => x.evolutionPoints - y.evolutionPoints);

  const byShift = POSTES.map((p) => ({ poste: p.poste, label: p.label, ...pair(byPoste.get(p.poste)) }));
  const series = (map) =>
    [...map.entries()]
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([date, bk]) => ({ date, total: bk.total, valides: bk.valides, conformes: bk.conformes, nonConformes: bk.nonConformes, tauxConformite: pct(bk.conformes, bk.valides) }));

  // Non-conformités par paramètre, toutes lignes confondues (classement).
  const ncByKey = new Map();
  for (const p of parameters) {
    const e = ncByKey.get(p.key) || { key: p.key, label: p.label, periodA: 0, periodB: 0, controlesA: 0, controlesB: 0 };
    e.periodA += p.periodA.nonConformes;
    e.periodB += p.periodB.nonConformes;
    e.controlesA += p.periodA.controles;
    e.controlesB += p.periodB.controles;
    ncByKey.set(p.key, e);
  }

  const response = {
    generatedAt: new Date().toISOString(),
    filters,
    // Filtres proposés par l'écran, tirés de la configuration et des données.
    options: {
      lines: cfg.productionLines.map((l) => ({ type: l.type, label: l.label, machines: l.machines })),
      postes: POSTES,
      controllers: controllers.map((c) => ({ id: c.id, email: c.email, label: controllerLabel(c.email) })),
      results: ["CONFORME", "NON_CONFORME", "A_VERIFIER"],
    },
    // Contrôleur affiché : le compte controle_qualite connecté (admins : tous
    // les comptes controle_qualite, ou celui du filtre).
    controleur: actor.role === cfg.role ? actor.email : controllers.find((c) => c.id === filters.controller)?.email || null,
    dataStatus,
    messages: buildMessages(a, b),
    comparable: a.total > 0 && b.total > 0,
    periodA: { ...periodA, ...a },
    periodB: { ...periodB, ...b },
    evolution: evolution(a, b),
    byType: lines.map((l) => ({ type: l.type, label: l.label, ...pair(byType.get(l.type)) })),
    byMachine: machineRows,
    ranking,
    byShift,
    shiftInsight: shiftInsight(byShift),
    daily: { periodA: series(byDay.A), periodB: series(byDay.B) },
    parameters,
    improvements,
    attentionPoints,
    byParameter: [...ncByKey.values()].map((e) => ({ ...e, total: e.periodA + e.periodB })).sort((x, y) => y.total - x.total || x.label.localeCompare(y.label)),
  };
  response.analysis = buildAnalysis(response);
  return response;
}

module.exports = { comparison, parseFilters, fmtDate, LIMITED_BELOW };
