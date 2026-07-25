"use strict";

const HrRequest = require("../../../models/HrRequest");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

const INCLUDE_ALL = [
  { model: User, as: "employee", attributes: ["id", "email", "role"] },
  {
    model: User,
    as: "reviewedByUser",
    attributes: ["id", "email"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
    required: false,
  },
  {
    model: User,
    as: "processedByUser",
    attributes: ["id", "email"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
    required: false,
  },
];

function findAll(where = {}) {
  return HrRequest.findAll({
    where,
    include: INCLUDE_ALL,
    order: [["createdAt", "DESC"]],
  });
}

function findById(id) {
  return HrRequest.findByPk(id, { include: INCLUDE_ALL });
}

function findBareById(id) {
  return HrRequest.findByPk(id);
}

function create(data) {
  return HrRequest.create(data);
}

function update(instance, data) {
  return instance.update(data);
}

function destroy(instance) {
  return instance.destroy();
}

module.exports = { findAll, findById, findBareById, create, update, destroy };
