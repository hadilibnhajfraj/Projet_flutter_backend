const svc = require("../services/pipelineStage.service");

function handle(res, err) {
  const status = err.status || 500;
  const message = err.message || "Internal server error";
  if (status >= 500) console.error("PipelineStage error:", err);
  res.status(status).json({ message });
}

async function getAll(req, res) {
  try {
    res.json({ data: await svc.getAllStages() });
  } catch (err) {
    handle(res, err);
  }
}

async function getById(req, res) {
  try {
    res.json({ data: await svc.getStageById(req.params.id) });
  } catch (err) {
    handle(res, err);
  }
}

// Body already validated + stripped by Joi middleware in the route
async function create(req, res) {
  try {
    res.status(201).json({ data: await svc.createStage(req.body, req.user.sub) });
  } catch (err) {
    handle(res, err);
  }
}

async function update(req, res) {
  try {
    res.json({ data: await svc.updateStage(req.params.id, req.body, req.user.sub) });
  } catch (err) {
    handle(res, err);
  }
}

async function remove(req, res) {
  try {
    res.json(await svc.deleteStage(req.params.id));
  } catch (err) {
    handle(res, err);
  }
}

async function reorder(req, res) {
  try {
    res.json({ data: await svc.reorderStages(req.body.stages) });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = { getAll, getById, create, update, remove, reorder };
