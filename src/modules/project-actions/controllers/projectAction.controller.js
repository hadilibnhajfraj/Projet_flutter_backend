const svc = require("../services/projectAction.service");

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error("ProjectAction error:", err);
  res.status(status).json({
    success: false,
    message: err.message || "Internal server error",
  });
}

// ── Project Actions ─────────────────────────────────────
// Validation is applied as middleware in the router — req.body is already
// validated and stripped of unknown fields before these handlers run.

async function listActions(req, res) {
  try {
    res.json(await svc.getProjectActions(req.params.projectId, req.query));
  } catch (err) {
    handle(res, err);
  }
}

async function getAction(req, res) {
  try {
    res.json({ data: await svc.getActionById(req.params.id) });
  } catch (err) {
    handle(res, err);
  }
}

async function createAction(req, res) {
  try {
    res.status(201).json({
      data: await svc.createAction(req.params.projectId, req.body, req.user.sub),
    });
  } catch (err) {
    handle(res, err);
  }
}

async function updateAction(req, res) {
  try {
    console.log("BODY =", req.body);
    console.log("FILE =", req.file);
    // Multer stores the file and populates req.file; inject the public URL so
    // the service can persist it and clean up the previous attachment.
    if (req.file) {
      req.body.fileUrl = `/uploads/actions/${req.file.filename}`;
    }
    res.json({
      success: true,
      data: await svc.updateAction(req.params.id, req.body, req.user.sub),
    });
  } catch (err) {
    handle(res, err);
  }
}

async function deleteAction(req, res) {
  try {
    res.json({ success: true, ...(await svc.deleteAction(req.params.id)) });
  } catch (err) {
    handle(res, err);
  }
}

// ── Action Types ──────────────────────────────────────────

async function listActionTypes(req, res) {
  try {
    res.json({ data: await svc.getAllActionTypes() });
  } catch (err) {
    handle(res, err);
  }
}

async function createActionType(req, res) {
  try {
    res.status(201).json({ data: await svc.createActionType(req.body) });
  } catch (err) {
    handle(res, err);
  }
}

async function updateActionType(req, res) {
  try {
    res.json({ data: await svc.updateActionType(req.params.id, req.body) });
  } catch (err) {
    handle(res, err);
  }
}

async function deleteActionType(req, res) {
  try {
    res.json(await svc.deleteActionType(req.params.id));
  } catch (err) {
    handle(res, err);
  }
}

module.exports = {
  listActions,
  getAction,
  createAction,
  updateAction,
  deleteAction,
  listActionTypes,
  createActionType,
  updateActionType,
  deleteActionType,
};
