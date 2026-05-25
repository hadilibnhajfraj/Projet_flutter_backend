const repo = require("../repositories/projectActivity.repository");

/**
 * Logs a project activity.
 * Can be called inside or outside a Sequelize transaction.
 *
 * @param {{ projectId, userId, type, message, metadata }} data
 * @param {import('sequelize').Transaction} [transaction]
 */
async function logActivity(data, transaction) {
  return repo.create(
    {
      projectId: data.projectId,
      userId: data.userId || null,
      type: data.type,
      message: data.message || null,
      metadata: data.metadata || null,
    },
    transaction
  );
}

async function getProjectActivities(projectId, query = {}) {
  const limit = Math.min(parseInt(query.limit) || 30, 200);
  const page = Math.max(parseInt(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const { count, rows } = await repo.findByProject(projectId, {
    limit,
    offset,
    type: query.type || undefined,
  });

  return {
    data: rows,
    total: count,
    page,
    pages: Math.ceil(count / limit),
  };
}

module.exports = { logActivity, getProjectActivities };
