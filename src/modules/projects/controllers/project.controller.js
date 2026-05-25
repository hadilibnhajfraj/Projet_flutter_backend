const svc = require("../services/project.service");

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

module.exports = { listProjects, moveStage, assignOwner };
