"use strict";

const RecuperableFiche = require("../../../models/RecuperableFiche");
const RecuperableLigne = require("../../../models/RecuperableLigne");
const User = require("../../../models/User");
require("../../../models/associations");

const INCLUDE_FULL = [
  { model: User, as: "creator", attributes: ["id", "email", "role"] },
  { model: RecuperableLigne, as: "lignes" },
];

function findAllFiches(where = {}) {
  return RecuperableFiche.findAll({
    where,
    include: INCLUDE_FULL,
    order: [["createdAt", "DESC"]],
  });
}

function findFicheById(id) {
  return RecuperableFiche.findByPk(id, { include: INCLUDE_FULL });
}

function findBareFicheById(id) {
  return RecuperableFiche.findByPk(id);
}

// Une seule fiche possible par Module + Machine + Ligne + Poste + Date —
// utilisé pour ouvrir automatiquement la fiche existante au lieu d'en
// recréer une.
function findFicheByCombo({ module, machine, ligne, poste, date }) {
  return RecuperableFiche.findOne({ where: { module, machine, ligne, poste, date }, include: INCLUDE_FULL });
}

function createFiche(data) {
  return RecuperableFiche.create(data);
}

function updateFiche(instance, data) {
  return instance.update(data);
}

function destroyFiche(instance) {
  return instance.destroy();
}

// Une ligne par (ficheId, diametre) — upsert : crée si absente, met à jour
// sinon (jamais de doublon, contrainte unique en DB en dernier recours).
async function upsertLigne(ficheId, diametre, data) {
  const [ligne] = await RecuperableLigne.findOrCreate({
    where: { ficheId, diametre },
    defaults: { ficheId, diametre, ...data },
  });
  return ligne.update(data);
}

module.exports = {
  findAllFiches,
  findFicheById,
  findBareFicheById,
  findFicheByCombo,
  createFiche,
  updateFiche,
  destroyFiche,
  upsertLigne,
};
