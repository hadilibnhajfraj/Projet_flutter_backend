const { Op, literal } = require("sequelize");
const PipelineStage = require("../../../models/PipelineStage");
const ProjectActionType = require("../../../models/ProjectActionType");

function findAll() {
  return PipelineStage.findAll({
    order: [["position", "ASC"]],
    include: [{ model: ProjectActionType, as: "actionTypes" }],
  });
}

function findById(id) {
  return PipelineStage.findByPk(id, {
    include: [{ model: ProjectActionType, as: "actionTypes" }],
  });
}

function findByName(name) {
  return PipelineStage.findOne({
    where: { name: { [Op.iLike]: name.trim() } },
  });
}

async function getMaxPosition() {
  const max = await PipelineStage.max("position");
  return max == null ? -1 : max;
}

function create(data, transaction) {
  return PipelineStage.create(data, { transaction });
}

async function update(id, data, transaction) {
  const [, rows] = await PipelineStage.update(data, {
    where: { id },
    returning: true,
    transaction,
  });
  return rows[0] || null;
}

function destroy(id, transaction) {
  return PipelineStage.destroy({ where: { id }, transaction });
}

/**
 * All stages with an inline projectsCount (non-archived projects only).
 * Single query — no N+1.
 */
function findAllWithProjectCount() {
  return PipelineStage.findAll({
    attributes: [
      "id",
      "name",
      "color",
      "icon",
      "position",
      "isWonStage",
      "isLostStage",
      "autoCreateAction",
      [
        literal(`(
          SELECT COUNT(*)::int
          FROM projects
          WHERE "pipelineStageId" = "PipelineStage".id
            AND "isArchived" = false
        )`),
        "projectsCount",
      ],
    ],
    order: [["position", "ASC"]],
  });
}

module.exports = { findAll, findAllWithProjectCount, findById, findByName, getMaxPosition, create, update, destroy };
