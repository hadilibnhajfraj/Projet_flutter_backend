const svc = require("../services/projectActivity.service");

function handle(res, err) {
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
}

async function listActivities(req, res) {
  try {
    res.json(await svc.getProjectActivities(req.params.projectId, req.query));
  } catch (err) {
    handle(res, err);
  }
}

module.exports = { listActivities };
