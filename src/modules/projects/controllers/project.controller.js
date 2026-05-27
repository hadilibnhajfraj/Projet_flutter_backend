const svc = require("../services/project.service");
const projectRepo = require("../repositories/project.repository");
const ProjectAction = require("../../../models/ProjectAction");
const ProjectReminder = require("../../../models/ProjectReminder");
const Project = require("../../../models/Project");

const ADMIN_ROLES = ["admin", "superadmin"];

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error("Project error:", err);
  res.status(status).json({ message: err.message || "Internal server error" });
}

// GET /projects/pipeline?mine=true&stageId=...&page=1
async function listProjects(req, res) {
  try {
    res.json(await svc.listProjects(req.query, req.user.sub));
  } catch (err) {
    handle(res, err);
  }
}

// PUT /projects/:id/move-stage — body validated by Joi middleware
async function moveStage(req, res) {
  try {
    res.json({
      data: await svc.moveStage(req.params.id, req.body.pipelineStageId, req.user.sub),
    });
  } catch (err) {
    handle(res, err);
  }
}

// PUT /projects/:id/owner — body validated by Joi middleware
async function assignOwner(req, res) {
  try {
    res.json({
      data: await svc.assignOwner(req.params.id, req.body.ownerId, req.user.sub),
    });
  } catch (err) {
    handle(res, err);
  }
}

// GET /projects/:id — full project detail for edit form pre-fill
// USER: own project only — ADMIN: any project
async function getProject(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.sub;
    const role = req.user?.role;

    const project = await projectRepo.findByIdFull(id);
    if (!project) return res.status(404).json({ message: "Project not found" });

    // Block archived projects for non-admins
    if (project.isArchived && !ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ message: "Projet archivé non accessible" });
    }

    // Non-admins: only their own project
    if (!ADMIN_ROLES.includes(role) && project.ownerId !== userId) {
      return res.status(403).json({ message: "Forbidden: not project owner" });
    }

    const p = project.toJSON();
    const ownerProfile = p.owner?.profile || {};

    res.json({
      ...p,
      // Explicit title alias so Flutter card never shows "Untitled"
      title: p.nomProjet || p.comptoir || null,
      // Normalised owner shape (fullName comes from UserProfile.name)
      owner: p.owner
        ? {
            id: p.owner.id,
            email: p.owner.email,
            fullName: ownerProfile.name || p.owner.email || null,
            avatarUrl: ownerProfile.avatarUrl || null,
          }
        : null,
    });
  } catch (err) {
    handle(res, err);
  }
}

// GET /projects/:projectId/timeline
// USER: only own projects — ADMIN: any project
async function getTimeline(req, res) {
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

    const timeline = await ProjectAction.findAll({
      where: { projectId },
      include: [{ model: ProjectReminder, as: "reminders" }],
      order: [["dateAction", "DESC"]],
    });

    res.json({ success: true, data: timeline });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = { listProjects, moveStage, assignOwner, getProject, getTimeline };
