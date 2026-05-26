const { Op } = require("sequelize");
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

// Returns the first action matching projectId + type + commentaire on the same
// calendar day. Treats null and '' as equivalent (matches the unique index).
function findDuplicate(projectId, typeAction_legacy, commentaire, dateAction) {
  const base = dateAction ? new Date(dateAction) : new Date();
  const dayStart = new Date(base);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(base);
  dayEnd.setHours(23, 59, 59, 999);

  // Null and empty-string are the same in the unique index (COALESCE to '').
  // Match both so the app-level check agrees with the DB constraint.
  const commentaireWhere = commentaire
    ? { commentaire }
    : { [Op.or]: [{ commentaire: null }, { commentaire: "" }] };

  return ProjectAction.findOne({
    where: {
      projectId,
      typeAction_legacy,
      ...commentaireWhere,
      dateAction: { [Op.between]: [dayStart, dayEnd] },
    },
  });
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
  findDuplicate,
  create,
  update,
  destroy,
  countByProject,
  findLastByProject,
};
