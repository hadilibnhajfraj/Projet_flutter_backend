"use strict";

// LISTE DES FICHES DE PRODUCTION PAR LIGNE — GET /production-records/fiches.
//
// Alimente les pages « Fiches de production PROMESH / PROBAR » : une ligne à
// la fois (type obligatoire), filtres combinables (période, machine, poste,
// statut de validation, recherche), tri, pagination, et compteurs calculés
// sur EXACTEMENT les mêmes filtres (hors statut de validation, pour que les
// cartes montrent la répartition des fiches filtrées).
//
// LECTURE SEULE, sur les tables existantes. Portée de lecture IDENTIQUE aux
// listes par ligne déjà en place (GET /por-promesh, GET /industrial-records —
// isReadScoped) : un compte de production (production_1..5) ne voit que ses
// fiches ; les responsables logistique et production (config/
// logisticsManagers.js) et les autres rôles autorisés voient toutes les
// fiches. GET /production-records (liste combinée) n'est PAS modifié.
//
// Fiches archivées exclues, comme dans les listes par ligne. Statut de
// validation (circuit des fiches) et verrouillage restent INDÉPENDANTS :
// `approval` (APPROVED / PENDING / REJECTED, null = hors circuit) et
// `isLocked` (saisie terminée, levé par un refus pour permettre la
// correction — même règle que les modèles Flutter).

const { Op, col, cast, where: sqWhere } = require("sequelize");
const PorPromesh = require("../../../models/PorPromesh");
const IndustrialRecord = require("../../../models/IndustrialRecord");
const User = require("../../../models/User");
require("../../../models/associations");
const logisticsManagers = require("../../../config/logisticsManagers");
const { computeDateRange } = require("../utils/dateRange");
const { normalizePromesh, normalizeProbar } = require("../dto/productionRecords.dto");

const TYPES = ["promesh", "probar"];
const APPROVALS = ["PENDING", "APPROVED", "REJECTED", "NONE"];
const MAX_LIMIT = 100;

const LINES = {
  promesh: {
    Model: PorPromesh,
    alias: "PorPromesh",
    date: "dateProduction",
    quantity: "productionM2",
    notArchived: { status: { [Op.ne]: "ARCHIVED" } },
    normalize: normalizePromesh,
    locked: (r) => Boolean(r.isLocked),
    // Statut de saisie, valeurs réelles de la colonne (jamais déduit).
    saisie: (r) => ({ BROUILLON: "brouillon", VALIDE: "validee" })[r.status] || "inconnu",
  },
  probar: {
    Model: IndustrialRecord,
    alias: "IndustrialRecord",
    date: "dateFiche",
    quantity: "quantiteProduite",
    notArchived: { module: "probar", statut: { [Op.ne]: "archivee" } },
    normalize: normalizeProbar,
    locked: (r) => r.statut === "validee",
    saisie: (r) => ({ brouillon: "brouillon", validee: "validee" })[r.statut] || "inconnu",
  },
};

const INCLUDE_CREATOR = [{ model: User, as: "creator", attributes: ["id", "email", "role"], required: false }];

function isReadScoped(actor) {
  return actor.role === "responsable_logistique_achat" && !logisticsManagers.isLogisticsManager(actor.email);
}

const SORTS = {
  date_desc: (line) => [[line.date, "DESC"], ["createdAt", "DESC"]],
  date_asc: (line) => [[line.date, "ASC"], ["createdAt", "ASC"]],
  quantite_desc: (line) => [[line.quantity, "DESC NULLS LAST"], [line.date, "DESC"]],
};

/** Clauses communes (sans le statut de validation). */
function baseWhere(type, filters, actor) {
  const line = LINES[type];
  const where = { ...line.notArchived };
  if (isReadScoped(actor)) where.createdBy = actor.id;
  if (filters.machine) where.machine = String(filters.machine);
  if (filters.poste) where.poste = String(filters.poste);
  const range = computeDateRange(filters.period, filters);
  if (range) where[line.date] = { [Op.gte]: range.start, [Op.lt]: range.end };

  const search = String(filters.search || "").trim();
  if (search) {
    const like = `%${search}%`;
    // Numéro complet saisi (PROMESH-2026-001708 / PROBAR-2026-A01847) : sa
    // dernière partie identifie la fiche (n° de séquence / début de l'id).
    const tail = search.includes("-") ? search.split("-").pop() : search;
    const or = [
      { operateur: { [Op.iLike]: like } },
      { machine: { [Op.iLike]: like } },
      sqWhere(cast(col(`${line.alias}.id`), "text"), { [Op.iLike]: `%${tail}%` }),
      sqWhere(cast(col(`${line.alias}.${line.date}`), "text"), { [Op.iLike]: like }),
    ];
    if (type === "promesh" && /^\d+$/.test(tail)) or.push({ sequenceNumber: Number(tail) });
    where[Op.and] = [...(where[Op.and] || []), { [Op.or]: or }];
  }
  return where;
}

function withApproval(where, approval) {
  if (!APPROVALS.includes(approval)) return where;
  return { ...where, approvalStatus: approval === "NONE" ? null : approval };
}

function approvalOf(r) {
  if (!r.approvalStatus) return null;
  return {
    status: r.approvalStatus,
    rejectionComment: r.approvalRejectionComment || null,
    decidedByEmail: r.approvalDecidedByEmail || null,
    decidedAt: r.approvalDecidedAt || null,
  };
}

async function listFiches(filters, actor) {
  const type = filters.type;
  if (!TYPES.includes(type)) throw { status: 400, message: "Type de fiche requis : promesh ou probar" };
  if (filters.period === "custom") {
    const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    if (!valid(filters.startDate) || !valid(filters.endDate)) throw { status: 400, message: "Période personnalisée : dates de début et de fin requises (AAAA-MM-JJ)" };
    if (filters.startDate > filters.endDate) throw { status: 400, message: "La date de début doit précéder la date de fin" };
  }
  const line = LINES[type];
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(filters.limit, 10) || 20));
  const order = (SORTS[filters.sort] || SORTS.date_desc)(line);

  const base = baseWhere(type, filters, actor);
  const where = withApproval(base, filters.approval);

  const [rows, total, groups] = await Promise.all([
    line.Model.findAll({ where, include: INCLUDE_CREATOR, order, limit, offset: (page - 1) * limit }),
    line.Model.count({ where }),
    line.Model.findAll({
      where: base,
      attributes: ["approvalStatus", [line.Model.sequelize.fn("COUNT", line.Model.sequelize.col("id")), "n"]],
      group: ["approvalStatus"],
      raw: true,
    }),
  ]);

  const count = (s) => groups.filter((g) => (s === null ? g.approvalStatus == null : g.approvalStatus === s)).reduce((a, g) => a + Number(g.n), 0);
  const summary = { total: groups.reduce((a, g) => a + Number(g.n), 0), approved: count("APPROVED"), pending: count("PENDING"), rejected: count("REJECTED"), none: count(null) };

  return {
    data: rows.map((rec) => {
      const r = rec.toJSON ? rec.toJSON() : rec;
      const approval = approvalOf(r);
      return {
        ...line.normalize(rec),
        // Mapping EXPLICITE (le DTO partagé ramène toute valeur inconnue à
        // « brouillon ») : une valeur inattendue est signalée « inconnu ».
        statut: line.saisie(r),
        approval,
        // Verrouillage indépendant du statut de validation ; un refus le lève
        // (correction autorisée), comme dans les modèles Flutter.
        isLocked: line.locked(r) && approval?.status !== "REJECTED",
      };
    }),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    summary,
  };
}

module.exports = { listFiches, isReadScoped, APPROVALS };
