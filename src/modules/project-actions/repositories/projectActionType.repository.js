const { Op } = require("sequelize");
const ProjectActionType = require("../../../models/ProjectActionType");
const PipelineStage = require("../../../models/PipelineStage");

function findAll() {
  return ProjectActionType.findAll({
    include: [{ model: PipelineStage, as: "linkedStage" }],
    order: [["name", "ASC"]],
  });
}

function findById(id) {
  return ProjectActionType.findByPk(id, {
    include: [{ model: PipelineStage, as: "linkedStage" }],
  });
}

function findByName(name) {
  return ProjectActionType.findOne({ where: { name: { [Op.iLike]: name.trim() } } });
}

function findByStageId(linkedStageId) {
  return ProjectActionType.findAll({ where: { linkedStageId } });
}

function create(data, transaction) {
  return ProjectActionType.create(data, { transaction });
}

async function update(id, data, transaction) {
  const [, rows] = await ProjectActionType.update(data, {
    where: { id },
    returning: true,
    transaction,
  });
  return rows[0] || null;
}

function destroy(id, transaction) {
  return ProjectActionType.destroy({ where: { id }, transaction });
}

module.exports = { findAll, findById, findByName, findByStageId, create, update, destroy };
