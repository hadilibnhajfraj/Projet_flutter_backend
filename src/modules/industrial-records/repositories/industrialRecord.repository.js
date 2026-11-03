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

function findById(id, transaction) {
  return IndustrialRecord.findByPk(id, { include: INCLUDE_CREATOR, transaction });
}

function findBareById(id, transaction) {
  return IndustrialRecord.findByPk(id, { transaction });
}

function create(data) {
  return IndustrialRecord.create(data);
}

function update(instance, data, transaction) {
  return instance.update(data, { transaction });
}

function destroy(instance, transaction) {
  return instance.destroy({ transaction });
}

module.exports = { findAll, count, findById, findBareById, create, update, destroy };
