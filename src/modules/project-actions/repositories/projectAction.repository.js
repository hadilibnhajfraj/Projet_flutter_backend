const ProjectAction = require("../../../models/ProjectAction");
const ProjectActionType = require("../../../models/ProjectActionType");
const ProjectReminder = require("../../../models/ProjectReminder");
const User = require("../../../models/User");

const BASE_INCLUDE = [
  { model: ProjectActionType, as: "actionType" },
  {
    model: ProjectReminder,
    as: "reminders",
    separate: true,
    order: [["dateRelance", "ASC"]],
  },
  { model: User, as: "creator", attributes: ["id", "email"] },
];

function findByProject(projectId, { limit = 50, offset = 0 } = {}) {
  return ProjectAction.findAndCountAll({
    where: { projectId },
    include: BASE_INCLUDE,
    order: [["dateAction", "DESC"]],
    limit,
    offset,
  });
}

function findById(id) {
  return ProjectAction.findByPk(id, { include: BASE_INCLUDE });
}

function create(data, transaction) {
  return ProjectAction.create(data, { transaction });
}

async function update(id, data, transaction) {
  const [, rows] = await ProjectAction.update(data, {
    where: { id },
    returning: true,
    transaction,
  });
  return rows[0] || null;
}

function destroy(id, transaction) {
  return ProjectAction.destroy({ where: { id }, transaction });
}

function countByProject(projectId) {
  return ProjectAction.count({ where: { projectId } });
}

function findLastByProject(projectId) {
  return ProjectAction.findOne({
    where: { projectId },
    order: [["dateAction", "DESC"]],
    include: [{ model: ProjectActionType, as: "actionType" }],
  });
}

module.exports = {
  findByProject,
  findById,
  create,
  update,
  destroy,
  countByProject,
  findLastByProject,
};
