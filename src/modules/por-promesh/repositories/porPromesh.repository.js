"use strict";

const { Op, fn, col, cast, where: sqWhere } = require("sequelize");
const PorPromesh = require("../../../models/PorPromesh");
const PorPromeshControleQualite = require("../../../models/PorPromeshControleQualite");
const PorPromeshArretMachine = require("../../../models/PorPromeshArretMachine");
const PorPromeshConsommation = require("../../../models/PorPromeshConsommation");
const PorPromeshProcessControl = require("../../../models/PorPromeshProcessControl");
const PorPromeshAttachment = require("../../../models/PorPromeshAttachment");
const PorPromeshNonConformite = require("../../../models/PorPromeshNonConformite");
const User = require("../../../models/User");
require("../../../models/associations");

const CHILD_MODELS = {
  controlesQualite: PorPromeshControleQualite,
  arretsMachine: PorPromeshArretMachine,
  consommations: PorPromeshConsommation,
  processControl: PorPromeshProcessControl,
  nonConformites: PorPromeshNonConformite,
};

const INCLUDE_CHILDREN = [
  { model: PorPromeshControleQualite, as: "controlesQualite" },
  { model: PorPromeshArretMachine, as: "arretsMachine" },
  { model: PorPromeshConsommation, as: "consommations" },
  { model: PorPromeshProcessControl, as: "processControl" },
  { model: PorPromeshNonConformite, as: "nonConformites" },
  { model: PorPromeshAttachment, as: "attachments" },
  { model: User, as: "creator", attributes: ["id", "email", "role"] },
];

const SORTS = {
  date_desc: [["dateProduction", "DESC"], ["createdAt", "DESC"]],
  date_asc: [["dateProduction", "ASC"], ["createdAt", "ASC"]],
  production_desc: [["productionM2", "DESC"], ["createdAt", "DESC"]],
};

// `light: true` saute les 6 jointures enfants (controlesQualite, arretsMachine,
// consommations, processControl, nonConformites, attachments) — utilisé par
// les écrans qui n'affichent que des champs de résumé (cartes/tableau du
// Dashboard du poste). Comportement par défaut (light absent/false)
// inchangé : tout appelant existant (écran détail, PDF, Excel, CRM
// liste/historique/dashboard) continue de recevoir les fiches pleinement
// hydratées comme avant.
function findAll(where = {}, { order, limit, offset, light = false } = {}) {
  return PorPromesh.findAll({
    where,
    include: light ? [] : INCLUDE_CHILDREN,
    order: SORTS[order] || SORTS.date_desc,
    limit,
    offset,
  });
}

function count(where = {}) {
  return PorPromesh.count({ where });
}

// Lecture allégée (sans les tables enfants) pour les agrégats Dashboard/Stats
// — tout le calcul (sommes, comptages, regroupement par heure/jour) se fait
// ensuite en JS dans le service, sur un volume par machine+poste qui reste
// petit (une fiche par poste et par jour).
function findForAggregates(where = {}) {
  return PorPromesh.findAll({
    where,
    attributes: ["productionM2", "conformite", "status", "operateur", "createdAt"],
    raw: true,
  });
}

// Bornes [start, end) sur createdAt pour les filtres de date relatifs —
// même découpage calendaire que celui déjà utilisé côté Dart (DateTime.now()
// + comparaison de date, jamais d'heure exacte).
function dateRangeWhere(range) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  const today = startOfDay(now);
  switch (range) {
    case "today":
      return { createdAt: { [Op.gte]: today, [Op.lt]: addDays(today, 1) } };
    case "yesterday":
      return { createdAt: { [Op.gte]: addDays(today, -1), [Op.lt]: today } };
    case "week": {
      const weekday = today.getDay() === 0 ? 7 : today.getDay(); // lundi = 1
      const startOfWeek = addDays(today, -(weekday - 1));
      return { createdAt: { [Op.gte]: startOfWeek, [Op.lt]: addDays(today, 1) } };
    }
    case "month": {
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      return { createdAt: { [Op.gte]: startOfMonth, [Op.lt]: addDays(today, 1) } };
    }
    default:
      return {};
  }
}

// Recherche libre sur opérateur / responsables / référence (id) / date —
// utilisée par la liste paginée (section "Recherche" du Dashboard du poste).
function searchClause(term) {
  const like = `%${term}%`;
  return {
    [Op.or]: [
      { operateur: { [Op.iLike]: like } },
      { responsable1: { [Op.iLike]: like } },
      { responsable2: { [Op.iLike]: like } },
      sqWhere(cast(col("PorPromesh.id"), "text"), { [Op.iLike]: like }),
      sqWhere(cast(col("PorPromesh.dateProduction"), "text"), { [Op.iLike]: like }),
    ],
  };
}

function findById(id, transaction) {
  return PorPromesh.findByPk(id, { include: INCLUDE_CHILDREN, transaction });
}

// Bare fetch (no includes) — used internally for ownership checks/updates
// where the full child set isn't needed.
function findBareById(id, transaction) {
  return PorPromesh.findByPk(id, { transaction });
}

function create(data, transaction) {
  return PorPromesh.create(data, { transaction });
}

function update(instance, data, transaction) {
  return instance.update(data, { transaction });
}

function destroy(instance) {
  return instance.destroy();
}

async function replaceChildren(porPromeshId, children, transaction) {
  for (const [key, Model] of Object.entries(CHILD_MODELS)) {
    const rows = children[key];
    if (!Array.isArray(rows)) continue;
    await Model.destroy({ where: { porPromeshId }, transaction });
    if (rows.length) {
      await Model.bulkCreate(
        rows.map((row) => ({ ...row, porPromeshId })),
        { transaction }
      );
    }
  }
}

function createAttachment(data) {
  return PorPromeshAttachment.create(data);
}

// Lecture brute des lignes "Contrôle Process" existantes — utilisée pour
// fusionner les 4 lignes générées automatiquement (Paramètres du Poste)
// sans écraser les 10 autres paramètres historiques quand le client
// n'envoie pas lui-même de tableau `processControl` complet.
function findProcessControl(porPromeshId, transaction) {
  return PorPromeshProcessControl.findAll({ where: { porPromeshId }, transaction, raw: true });
}

module.exports = {
  CHILD_MODELS,
  findAll,
  count,
  findForAggregates,
  dateRangeWhere,
  searchClause,
  findById,
  findBareById,
  create,
  update,
  destroy,
  replaceChildren,
  createAttachment,
  findProcessControl,
};
