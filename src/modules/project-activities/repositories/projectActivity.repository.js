const ProjectActivity = require("../../../models/ProjectActivity");
const User = require("../../../models/User");

function findByProject(projectId, { limit = 50, offset = 0, type } = {}) {
  const where = { projectId };
  if (type) where.type = type;

  return ProjectActivity.findAndCountAll({
    where,
    include: [{ model: User, as: "user", attributes: ["id", "email"] }],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });
}

function create(data, transaction) {
  return ProjectActivity.create(data, { transaction });
}

module.exports = { findByProject, create };
