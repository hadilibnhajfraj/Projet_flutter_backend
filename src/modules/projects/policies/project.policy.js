const Project = require("../../../models/Project");

const ADMIN_ROLES = ["admin", "superadmin"];

async function canEdit(userId, role, projectId) {
  if (ADMIN_ROLES.includes(role)) return true;
  const project = await Project.findByPk(projectId, { attributes: ["ownerId"] });
  if (!project) return false;
  return project.ownerId === userId;
}

/**
 * Middleware: only project owner or admin may proceed.
 * Reads projectId from req.params.id
 */
function requireOwnerOrAdmin(req, res, next) {
  const userId = req.user?.sub;
  const role = req.user?.role;

  if (ADMIN_ROLES.includes(role)) return next();

  const projectId = req.params.id;
  if (!projectId) return res.status(400).json({ message: "Missing project id" });

  canEdit(userId, role, projectId)
    .then((allowed) => {
      if (!allowed) return res.status(403).json({ message: "Forbidden: not project owner" });
      next();
    })
    .catch(() => res.status(500).json({ message: "Policy check failed" }));
}

module.exports = { canEdit, requireOwnerOrAdmin };
