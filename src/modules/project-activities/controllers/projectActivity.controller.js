const svc = require("../services/projectActivity.service");
const Project = require("../../../models/Project");

const ADMIN_ROLES = ["admin", "superadmin"];

function handle(res, err) {
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
}

async function listActivities(req, res) {
  try {
    const { projectId } = req.params;
    const userId = req.user?.sub;
    const role = req.user?.role;

    if (!ADMIN_ROLES.includes(role)) {
      const project = await Project.findOne({
        where: { id: projectId, ownerId: userId },
        attributes: ["id"],
      });
      if (!project) {
        return res.status(403).json({ message: "Forbidden: not project owner" });
      }
    }

    res.json(await svc.getProjectActivities(projectId, req.query));
  } catch (err) {
    handle(res, err);
  }
}

module.exports = { listActivities };
