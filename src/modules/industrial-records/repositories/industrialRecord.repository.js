"use strict";

const IndustrialRecord = require("../../../models/IndustrialRecord");
const User = require("../../../models/User");
require("../../../models/associations");

const INCLUDE_CREATOR = [{ model: User, as: "creator", attributes: ["id", "email", "role"] }];

// `limit`/`offset` bornent la taille de l'historique renvoyée en une fois —
// couvert par l'index composite (module, dateFiche, createdAt) de la
// migration 20260707000001, qui évite un tri Postgres séparé après filtre.
function findAll(where = {}, { limit, offset } = {}) {
  return IndustrialRecord.findAll({
    where,
    include: INCLUDE_CREATOR,
    order: [["dateFiche", "DESC"], ["createdAt", "DESC"]],
    limit,
    offset,
  });
}

function count(where = {}) {
  return IndustrialRecord.count({ where });
}

function findById(id) {
  return IndustrialRecord.findByPk(id, { include: INCLUDE_CREATOR });
}

function findBareById(id) {
  return IndustrialRecord.findByPk(id);
}

function create(data) {
  return IndustrialRecord.create(data);
}

function update(instance, data) {
  return instance.update(data);
}

function destroy(instance) {
  return instance.destroy();
}

module.exports = { findAll, count, findById, findBareById, create, update, destroy };
