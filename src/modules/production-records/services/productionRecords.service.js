"use strict";

// Service "Fiches de production" — vue centralisée en LECTURE des fiches
// PROMESH (table por_promesh) et PROBAR (table industrial_records,
// module='probar'). Ne crée ni ne duplique aucune donnée : interroge les
// deux tables existantes via leurs modèles Sequelize, normalise (voir dto/)
// et fusionne le résultat pour une pagination/tri unifiés.

const { Op, col, fn, literal } = require("sequelize");
const PorPromesh = require("../../../models/PorPromesh");
const IndustrialRecord = require("../../../models/IndustrialRecord");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

const { computeDateRange } = require("../utils/dateRange");
const { normalizePromesh, normalizeProbar, buildPromeshDetail, buildProbarDetail } = require("../dto/productionRecords.dto");

// Détail : délègue entièrement aux services par module existants
// (permission/ownership déjà vérifiés là-bas — voir assertOwnership dans
// chacun) plutôt que de dupliquer cette logique ici. Le DTO ci-dessus ne
// fait que reformer la réponse déjà complète de chaque module.
const porPromeshService = require("../../por-promesh/services/porPromesh.service");
const { toPorPromeshResponse } = require("../../por-promesh/dto/porPromesh.dto");
const industrialRecordService = require("../../industrial-records/services/industrialRecord.service");
const { toIndustrialRecordResponse } = require("../../industrial-records/dto/industrialRecord.dto");

const INCLUDE_CREATOR = [{ model: User, as: "creator", attributes: ["id", "email", "role"] }];

// Même règle que por-promesh/industrial-records : responsable_logistique_achat
// ne voit que ses propres fiches, admin/superadmin voient tout.
// finance_production (§MODIFICATION — DASHBOARD PRODUCTION) est
// délibérément EXCLU de l'owner-scoping — ce rôle consulte toutes les
// fiches (dashboard, records, summary, stats), comme admin/superadmin.
function isOwnerScoped(role) {
  return role === "responsable_logistique_achat";
}

const HARD_FETCH_CAP = 1000;

// Colonne réelle par source pour chaque clé de tri exposée côté API.
const SORT_COLUMNS = {
  promesh: { date: "dateProduction", machine: "machine", poste: "poste", quantite: "productionM2", statut: "status" },
  probar: { date: "dateFiche", machine: "machine", poste: "poste", quantite: "quantiteProduite", statut: "statut" },
};

function parseSort(sort) {
  const raw = (sort || "date_desc").toString();
  const dir = raw.endsWith("_asc") ? "ASC" : "DESC";
  const field = raw.replace(/_(asc|desc)$/, "");
  const key = ["date", "machine", "poste", "type", "quantite", "statut"].includes(field) ? field : "date";
  return { field: key, dir };
}

// §MODIFICATION — ADMIN > PRODUCTION RECORDS — FILTRE PAR UTILISATEUR :
// `filters.createdBy` (id utilisateur) est un filtre EXPLICITE, appliqué
// UNIQUEMENT pour un rôle NON owner-scoped (Admin/superadmin — les seuls
// pour qui `where` part vide, donc capables de voir plusieurs utilisateurs).
// SÉCURITÉ CRITIQUE (§5/§10) : pour un rôle owner-scoped
// (responsable_logistique_achat, y compris production_1..5), `where.createdBy`
// est DÉJÀ figé à `actor.id` — ce filtre ne doit JAMAIS l'écraser, sinon un
// compte Production pourrait passer `?createdBy=<autre utilisateur>` et
// voir les fiches de quelqu'un d'autre. Jamais une valeur envoyée par le
// client ne doit pouvoir élargir un accès déjà restreint.
function applyCreatedByFilter(where, filters, actor) {
  if (filters.createdBy && !isOwnerScoped(actor.role)) where.createdBy = filters.createdBy;
  return where;
}

function buildPromeshWhere(filters, actor) {
  const where = isOwnerScoped(actor.role) ? { createdBy: actor.id } : {};
  applyCreatedByFilter(where, filters, actor);
  if (filters.machineId) where.machine = filters.machineId;
  if (filters.poste) where.poste = filters.poste;

  const range = computeDateRange(filters.period, filters);
  if (range) where.dateProduction = { [Op.gte]: range.start, [Op.lt]: range.end };

  return where;
}

// Recherche libre : numéro (id), opérateur, machine, taille de maille,
// diamètre, date, quantité — castée en texte quand nécessaire (id/date/
// productionM2 ne sont pas des colonnes texte).
function applyPromeshSearch(where, search) {
  if (!search) return where;
  const { cast, where: sqWhere } = require("sequelize");
  const like = `%${search}%`;
  where[Op.and] = [
    ...(where[Op.and] || []),
    {
      [Op.or]: [
        { operateur: { [Op.iLike]: like } },
        { machine: { [Op.iLike]: like } },
        { diametreMaille1: { [Op.iLike]: like } },
        { diametreMaille2: { [Op.iLike]: like } },
        sqWhere(cast(col("PorPromesh.id"), "text"), { [Op.iLike]: like }),
        sqWhere(cast(col("PorPromesh.dateProduction"), "text"), { [Op.iLike]: like }),
        sqWhere(cast(col("PorPromesh.productionM2"), "text"), { [Op.iLike]: like }),
      ],
    },
  ];
  return where;
}

function buildProbarWhere(filters, actor) {
  const where = { module: "probar", ...(isOwnerScoped(actor.role) ? { createdBy: actor.id } : {}) };
  applyCreatedByFilter(where, filters, actor);
  if (filters.machineId) where.machine = filters.machineId;
  if (filters.poste) where.poste = filters.poste;

  const range = computeDateRange(filters.period, filters);
  if (range) where.dateFiche = { [Op.gte]: range.start, [Op.lt]: range.end };

  return where;
}

function applyProbarSearch(where, search) {
  if (!search) return where;
  const { cast, where: sqWhere } = require("sequelize");
  const like = `%${search}%`;
  where[Op.and] = [
    ...(where[Op.and] || []),
    {
      [Op.or]: [
        { operateur: { [Op.iLike]: like } },
        { machine: { [Op.iLike]: like } },
        { description: { [Op.iLike]: like } },
        sqWhere(cast(col("IndustrialRecord.id"), "text"), { [Op.iLike]: like }),
        sqWhere(cast(col("IndustrialRecord.dateFiche"), "text"), { [Op.iLike]: like }),
        sqWhere(cast(col("IndustrialRecord.quantiteProduite"), "text"), { [Op.iLike]: like }),
      ],
    },
  ];
  return where;
}

function comparator(field, dir) {
  const mul = dir === "ASC" ? 1 : -1;
  return (a, b) => {
    let av, bv;
    switch (field) {
      case "machine":
        av = a.machine || "";
        bv = b.machine || "";
        break;
      case "poste":
        av = a.poste || "";
        bv = b.poste || "";
        break;
      case "type":
        av = a.type;
        bv = b.type;
        break;
      case "quantite":
        av = a.quantite ?? -Infinity;
        bv = b.quantite ?? -Infinity;
        break;
      case "statut":
        av = a.statut || "";
        bv = b.statut || "";
        break;
      case "date":
      default:
        av = toComparableTime(a.date) ?? toComparableTime(a.createdAt) ?? -Infinity;
        bv = toComparableTime(b.date) ?? toComparableTime(b.createdAt) ?? -Infinity;
    }
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    // Départage stable par createdAt desc — évite un ordre qui varie d'une
    // requête à l'autre pour des lignes à valeur de tri identique.
    // `createdAt` est un objet Date (ou une chaîne ISO) selon la source
    // Sequelize — jamais comparé via localeCompare (réservé aux chaînes,
    // lève une TypeError sur un Date, cause du HTTP 500 sur "Toutes").
    const bTime = toComparableTime(b.createdAt) ?? -Infinity;
    const aTime = toComparableTime(a.createdAt) ?? -Infinity;
    return bTime - aTime;
  };
}

// Normalise une date (Date | string ISO | null/undefined) en timestamp
// numérique comparable — évite de mélanger des types (Date vs String) dans
// les comparaisons `<`/`>` ou d'appeler une méthode String (localeCompare)
// sur un objet Date. Retourne `null` si la valeur est absente/invalide.
function toComparableTime(value) {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

async function listRecords(filters, actor) {
  const type = ["probar", "promesh"].includes(filters.type) ? filters.type : "all";
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(filters.limit, 10) || 20));
  const { field, dir } = parseSort(filters.sort);

  const wantPromesh = type === "all" || type === "promesh";
  const wantProbar = type === "all" || type === "probar";

  const promeshWhere = wantPromesh ? applyPromeshSearch(buildPromeshWhere(filters, actor), filters.search) : null;
  const probarWhere = wantProbar ? applyProbarSearch(buildProbarWhere(filters, actor), filters.search) : null;

  const [promeshTotal, probarTotal] = await Promise.all([
    wantPromesh ? PorPromesh.count({ where: promeshWhere }) : 0,
    wantProbar ? IndustrialRecord.count({ where: probarWhere }) : 0,
  ]);
  const total = promeshTotal + probarTotal;

  let data;

  if (type === "promesh") {
    const rows = await PorPromesh.findAll({
      where: promeshWhere,
      include: INCLUDE_CREATOR,
      order: [[SORT_COLUMNS.promesh[field] || "dateProduction", dir]],
      limit,
      offset: (page - 1) * limit,
    });
    data = rows.map(normalizePromesh);
  } else if (type === "probar") {
    const rows = await IndustrialRecord.findAll({
      where: probarWhere,
      include: INCLUDE_CREATOR,
      order: [[SORT_COLUMNS.probar[field] || "dateFiche", dir]],
      limit,
      offset: (page - 1) * limit,
    });
    data = rows.map(normalizeProbar);
  } else {
    // Union applicative : chaque source est déjà triée/filtrée en SQL par le
    // MÊME critère demandé et bornée à (page*limit), donc la fenêtre finale
    // [offset, offset+limit) du merge JS est garantie correcte (argument
    // classique de fusion top-N k-way) sans jamais rapatrier tout l'historique.
    const sourceLimit = Math.min(page * limit, HARD_FETCH_CAP);
    const [promeshRows, probarRows] = await Promise.all([
      PorPromesh.findAll({
        where: promeshWhere,
        include: INCLUDE_CREATOR,
        order: [[SORT_COLUMNS.promesh[field] || "dateProduction", dir]],
        limit: sourceLimit,
      }),
      IndustrialRecord.findAll({
        where: probarWhere,
        include: INCLUDE_CREATOR,
        order: [[SORT_COLUMNS.probar[field] || "dateFiche", dir]],
        limit: sourceLimit,
      }),
    ]);
    const merged = [...promeshRows.map(normalizePromesh), ...probarRows.map(normalizeProbar)];
    merged.sort(comparator(field, dir));
    data = merged.slice((page - 1) * limit, page * limit);
  }

  return {
    data,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

// Statistiques globales (indépendantes des filtres période/machine/poste du
// tableau — voir cartes KPI en haut de page) : bornées par le scope de rôle,
// PLUS désormais le filtre "Created by" (§11 : les KPI doivent se
// recalculer quand ce filtre change, ex. "All users" Total=100 →
// "production_1" Total=25) — jamais les autres filtres (période/machine/
// poste), qui restent volontairement globaux pour ces cartes.
async function getStatistics(filters, actor) {
  const scopeWhere = isOwnerScoped(actor.role) ? { createdBy: actor.id } : {};
  applyCreatedByFilter(scopeWhere, filters, actor);
  const weekRange = computeDateRange("week");
  const monthRange = computeDateRange("month");

  const [promeshTotal, probarTotal, promeshWeek, probarWeek, promeshMonth, probarMonth] = await Promise.all([
    PorPromesh.count({ where: scopeWhere }),
    IndustrialRecord.count({ where: { ...scopeWhere, module: "probar" } }),
    PorPromesh.count({ where: { ...scopeWhere, dateProduction: { [Op.gte]: weekRange.start, [Op.lt]: weekRange.end } } }),
    IndustrialRecord.count({
      where: { ...scopeWhere, module: "probar", dateFiche: { [Op.gte]: weekRange.start, [Op.lt]: weekRange.end } },
    }),
    PorPromesh.count({ where: { ...scopeWhere, dateProduction: { [Op.gte]: monthRange.start, [Op.lt]: monthRange.end } } }),
    IndustrialRecord.count({
      where: { ...scopeWhere, module: "probar", dateFiche: { [Op.gte]: monthRange.start, [Op.lt]: monthRange.end } },
    }),
  ]);

  return {
    total: promeshTotal + probarTotal,
    probar: probarTotal,
    promesh: promeshTotal,
    thisWeek: promeshWeek + probarWeek,
    thisMonth: promeshMonth + probarMonth,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// KPI industriels ("Quantité produite" / "Diamètre produit" / "Taille de
// maille produite") — SUM calculées en SQL (jamais en rapatriant les
// fiches côté Node), connectées aux mêmes filtres que listRecords, et
// bornées aux fiches VALIDÉES uniquement (voir point 5 du cahier des
// charges — même règle que le déverrouillage automatique/la validation
// manuelle : BROUILLON n'est jamais compté comme production définitive).
//
// Colonnes réelles utilisées (voir modèles Sequelize) :
//   • PorPromesh.productionM2      (DECIMAL) → quantité PROMESH, en m²
//   • PorPromesh.diametreMaille1   (STRING)  → "taille de maille" PROMESH
//   • PorPromesh.diametreMaille2   (STRING)  → "diamètre" PROMESH
//   • IndustrialRecord.quantiteProduite (DECIMAL) → quantité PROBAR, en m
//   • IndustrialRecord.description (TEXT, JSON compact, clé "dia")
//     → "diamètre" PROBAR (aucune colonne dédiée, voir
//     productionRecords.dto.js#extractProbarDiameter) — extrait par regex
//     SQL, jamais par un cast JSON qui lèverait une erreur sur une ligne
//     ancienne/non-JSON.
//
// `diametreMaille1`/`diametreMaille2` sont des colonnes texte libres (ex.
// "50 x 50" pour une taille de maille composée) — un CAST direct en
// numeric ferait échouer toute la requête sur la première valeur non
// numérique. Chaque expression ci-dessous vérifie donc le format via une
// regex avant de caster, et ignore silencieusement (0, jamais d'erreur)
// toute valeur vide/nulle/non numérique — jamais de valeur inventée.
const NUMERIC_PATTERN = "^[0-9]+(\\.[0-9]+)?$";

function safeSumOfNumericColumn(column) {
  return literal(`SUM(CASE WHEN "${column}" ~ '${NUMERIC_PATTERN}' THEN "${column}"::numeric ELSE 0 END)`);
}

function safeSumOfProbarDiameter() {
  const extract = `substring("description" from '"dia":"([^"]*)"')`;
  return literal(`SUM(CASE WHEN ${extract} ~ '${NUMERIC_PATTERN}' THEN ${extract}::numeric ELSE 0 END)`);
}

function toNumberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getProductionTotals(filters, actor) {
  const type = ["probar", "promesh"].includes(filters.type) ? filters.type : "all";
  const wantPromesh = type === "all" || type === "promesh";
  const wantProbar = type === "all" || type === "probar";

  const promeshWhere = wantPromesh ? { ...buildPromeshWhere(filters, actor), status: "VALIDE" } : null;
  const probarWhere = wantProbar ? { ...buildProbarWhere(filters, actor), statut: "validee" } : null;

  const [promeshAgg, probarAgg] = await Promise.all([
    wantPromesh
      ? PorPromesh.findOne({
          where: promeshWhere,
          attributes: [
            [fn("SUM", col("productionM2")), "quantity"],
            [safeSumOfNumericColumn("diametreMaille2"), "diameter"],
            [safeSumOfNumericColumn("diametreMaille1"), "meshSize"],
          ],
          raw: true,
        })
      : null,
    wantProbar
      ? IndustrialRecord.findOne({
          where: probarWhere,
          attributes: [
            [fn("SUM", col("quantiteProduite")), "quantity"],
            [safeSumOfProbarDiameter(), "diameter"],
          ],
          raw: true,
        })
      : null,
  ]);

  return {
    probar: wantProbar
      ? {
          quantity: toNumberOrZero(probarAgg?.quantity),
          quantityUnite: "m",
          diameter: toNumberOrZero(probarAgg?.diameter),
          diameterUnite: "mm",
        }
      : null,
    promesh: wantPromesh
      ? {
          quantity: toNumberOrZero(promeshAgg?.quantity),
          quantityUnite: "m²",
          diameter: toNumberOrZero(promeshAgg?.diameter),
          diameterUnite: "mm",
          meshSize: toNumberOrZero(promeshAgg?.meshSize),
          meshSizeUnite: "mm",
        }
      : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// "Production Summary" — le MÊME jeu de fiches que "Production records"
// (listRecords ci-dessus), une ligne par fiche (id/date/machine/diamètre/
// cell size/quantité — voir normalizePromesh/normalizeProbar, aucun champ
// réinventé), borné aux fiches VALIDÉES par défaut (même règle que
// getProductionTotals/le verrouillage automatique) — un filtre "Statut"
// explicite permet néanmoins d'inclure aussi les brouillons ou absolument
// tout. grandTotal/totalRecords sont calculés à partir de CES MÊMES lignes
// (jamais une requête SQL séparée qui pourrait diverger) — l'écran et
// l'export Excel/PDF affichent donc toujours exactement les mêmes chiffres.
// ═══════════════════════════════════════════════════════════════════════

function resolveSummaryStatus(filters) {
  return ["brouillon", "all"].includes(filters.status) ? filters.status : "validee";
}

function applyPromeshSummaryFilters(where, filters) {
  const status = resolveSummaryStatus(filters);
  if (status === "validee") where.status = "VALIDE";
  else if (status === "brouillon") where.status = "BROUILLON";
  // "all" : aucun filtre de statut.
  if (filters.diameter) where.diametreMaille2 = filters.diameter;
  return where;
}

function applyProbarSummaryFilters(where, filters) {
  const status = resolveSummaryStatus(filters);
  if (status === "validee") where.statut = "validee";
  else if (status === "brouillon") where.statut = { [Op.ne]: "validee" };
  if (filters.diameter) {
    const { where: sqWhere } = require("sequelize");
    where[Op.and] = [
      ...(where[Op.and] || []),
      // Comparaison paramétrée (jamais d'interpolation directe de
      // filters.diameter dans le SQL — évite toute injection).
      sqWhere(literal(`substring("description" from '"dia":"([^"]*)"')`), filters.diameter),
    ];
  }
  return where;
}

async function buildPromeshSummary(filters, actor) {
  const where = applyPromeshSummaryFilters(buildPromeshWhere(filters, actor), filters);

  const records = await PorPromesh.findAll({
    where,
    include: INCLUDE_CREATOR,
    order: [["dateProduction", "DESC"]],
    limit: HARD_FETCH_CAP,
  });

  const rows = records.map(normalizePromesh);
  const grandTotal = rows.reduce((sum, r) => sum + (r.quantite || 0), 0);

  return { rows, grandTotal, unit: "m²", totalRecords: rows.length };
}

async function buildProbarSummary(filters, actor) {
  const where = applyProbarSummaryFilters(buildProbarWhere(filters, actor), filters);

  const records = await IndustrialRecord.findAll({
    where,
    include: INCLUDE_CREATOR,
    order: [["dateFiche", "DESC"]],
    limit: HARD_FETCH_CAP,
  });

  const rows = records.map(normalizeProbar);
  const grandTotal = rows.reduce((sum, r) => sum + (r.quantite || 0), 0);

  return { rows, grandTotal, unit: "m", totalRecords: rows.length };
}

async function getProductionSummary(filters, actor) {
  const type = ["probar", "promesh"].includes(filters.type) ? filters.type : "all";
  const wantPromesh = type === "all" || type === "promesh";
  const wantProbar = type === "all" || type === "probar";

  const [promesh, probar] = await Promise.all([
    wantPromesh ? buildPromeshSummary(filters, actor) : null,
    wantProbar ? buildProbarSummary(filters, actor) : null,
  ]);

  return { promesh, probar };
}

// Machines/postes réellement présents en base (bornés par le scope de
// rôle) — alimente les dropdowns "Toutes les machines"/"Tous les postes"
// sans valeur hardcodée côté Flutter.
async function distinctValues(Model, attribute, where) {
  const rows = await Model.findAll({
    where,
    attributes: [[fn("DISTINCT", col(attribute)), "value"]],
    raw: true,
  });
  return rows.map((r) => r.value).filter((v) => v != null && String(v).trim() !== "");
}

// Variante pour une expression SQL arbitraire (ex. extraction JSON) plutôt
// qu'une colonne nommée — utilisée pour le diamètre PROBAR (`dia`, dans le
// blob `description`, voir buildProbarSummary).
async function distinctValuesExpr(Model, sqlExpr, where) {
  const rows = await Model.findAll({
    where,
    attributes: [[literal(sqlExpr), "value"]],
    group: [literal(sqlExpr)],
    raw: true,
  });
  return rows.map((r) => r.value).filter((v) => v != null && String(v).trim() !== "");
}

function sortDiameters(values) {
  return Array.from(new Set(values.map(String))).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNumeric = Number.isFinite(na) && /^[0-9]+(\.[0-9]+)?$/.test(a);
    const bNumeric = Number.isFinite(nb) && /^[0-9]+(\.[0-9]+)?$/.test(b);
    if (aNumeric && bNumeric) return na - nb;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a.localeCompare(b);
  });
}

async function getFilters(actor) {
  const scopeWhere = isOwnerScoped(actor.role) ? { createdBy: actor.id } : {};
  const probarScopeWhere = { ...scopeWhere, module: "probar" };

  const [promeshMachines, probarMachines, promeshPostes, probarPostes, promeshDiameters, probarDiameters] = await Promise.all([
    distinctValues(PorPromesh, "machine", scopeWhere),
    distinctValues(IndustrialRecord, "machine", probarScopeWhere),
    distinctValues(PorPromesh, "poste", scopeWhere),
    distinctValues(IndustrialRecord, "poste", probarScopeWhere),
    distinctValues(PorPromesh, "diametreMaille2", scopeWhere),
    distinctValuesExpr(IndustrialRecord, `substring("description" from '"dia":"([^"]*)"')`, probarScopeWhere),
  ]);

  const machines = new Set([...promeshMachines, ...probarMachines].map(String));
  const postes = new Set([...promeshPostes, ...probarPostes].map(String));

  return {
    machines: Array.from(machines).sort(),
    postes: Array.from(postes).sort(),
    diameters: sortDiameters([...promeshDiameters, ...probarDiameters]),
  };
}

// §MODIFICATION — ADMIN > PRODUCTION RECORDS — FILTRE PAR UTILISATEUR (§3) :
// alimente le dropdown "All users" — UNIQUEMENT les utilisateurs ayant
// RÉELLEMENT créé au moins une fiche (PROMESH ou PROBAR), jamais la liste
// complète des comptes de l'application ni une valeur codée en dur côté
// Flutter. Un rôle owner-scoped n'a de toute façon accès qu'à ses propres
// fiches (`isOwnerScoped`, voir buildPromeshWhere/buildProbarWhere) — pour
// lui, cette liste ne peut jamais contenir qu'un seul utilisateur (lui-même),
// jamais un moyen de découvrir qui d'autre existe.
async function getCreators(actor) {
  const promeshWhere = isOwnerScoped(actor.role) ? { createdBy: actor.id } : {};
  const probarWhere = { module: "probar", ...(isOwnerScoped(actor.role) ? { createdBy: actor.id } : {}) };

  const [promeshIds, probarIds] = await Promise.all([
    distinctValues(PorPromesh, "createdBy", promeshWhere),
    distinctValues(IndustrialRecord, "createdBy", probarWhere),
  ]);
  const ids = Array.from(new Set([...promeshIds, ...probarIds].filter(Boolean)));
  if (!ids.length) return [];

  const users = await User.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ["id", "email", "role"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
    order: [["email", "ASC"]],
  });

  return users.map((u) => {
    const j = u.toJSON();
    const profile = j.profile || {};
    const fullName = (profile.name && profile.name.trim()) || [profile.prenom, profile.nom].filter(Boolean).join(" ").trim() || null;
    return { id: j.id, email: j.email, role: j.role, name: fullName || null };
  });
}

function parseCompositeId(id) {
  const [type, uuid] = String(id || "").split(":");
  if (!uuid || !["promesh", "probar"].includes(type)) {
    throw { status: 400, message: "Identifiant de fiche invalide" };
  }
  return { type, uuid };
}

// Détail complet d'une fiche — réutilise le service ET le DTO déjà existants
// de chaque module (mêmes vérifications de permission/ownership que
// GET /por-promesh/:id et GET /industrial-records/:id, jamais dupliquées ici).
async function getRecordById(compositeId, actor) {
  const { type, uuid } = parseCompositeId(compositeId);

  if (type === "promesh") {
    const record = await porPromeshService.getPorPromeshById(uuid, actor); // 404/403 déjà gérés
    return buildPromeshDetail(toPorPromeshResponse(record));
  }

  // IndustrialRecord est partagé PROBAR/MÉLANGE/MAINTENANCE — le service
  // générique ne filtre pas par module, donc on vérifie nous-mêmes qu'il
  // s'agit bien d'une fiche PROBAR avant de construire le détail (sinon une
  // fiche Mélange/Maintenance serait accessible via un id "probar:...").
  const record = await industrialRecordService.getRecordById(uuid, actor); // 404/403 déjà gérés
  if (record.module !== "probar") throw { status: 404, message: "Fiche introuvable" };
  return buildProbarDetail(toIndustrialRecordResponse(record, { light: false }));
}

module.exports = { listRecords, getStatistics, getProductionTotals, getProductionSummary, getFilters, getCreators, getRecordById };
