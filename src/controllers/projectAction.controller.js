const { ProjectAction, ProjectReminder, Project } = require("../models/associations");

const ADMIN_ROLES = ["admin", "superadmin"];

async function assertProjectAccess(projectId, req, res) {
  if (ADMIN_ROLES.includes(req.user?.role)) return true;
  const project = await Project.findOne({
    where: { id: projectId, ownerId: req.user?.sub },
    attributes: ["id"],
  });
  if (!project) {
    res.status(403).json({ success: false, message: "Forbidden: not project owner" });
    return false;
  }
  return true;
}

const log = {
  info: (msg, meta = {}) =>
    console.log(JSON.stringify({ level: "info", msg, ...meta, ts: new Date().toISOString() })),
  warn: (msg, meta = {}) =>
    console.warn(JSON.stringify({ level: "warn", msg, ...meta, ts: new Date().toISOString() })),
  error: (msg, meta = {}) =>
    console.error(JSON.stringify({ level: "error", msg, ...meta, ts: new Date().toISOString() })),
};

// ==============================
// CREATE ACTION
// ==============================
exports.createAction = async (req, res) => {

  const { projectId } = req.params;

  const createdBy =
    req.user?.id || req.body.createdBy;

  // =====================================
  // LEGACY ACTION TYPE
  // =====================================

  const actionTypeLabel =
    req.body.typeAction ||
    req.body.typeAction_legacy ||
    req.body.firstAction ||
    "Visite";

  const {
    commentaire,
    dateAction,
    dateRelance,
    statut,
    actionTypeId,
  } = req.body;

  log.info("createAction", {
    projectId,
    actionTypeLabel,
    createdBy,
  });

  try {

    const action = await ProjectAction.create({

      projectId,

      // OLD SYSTEM
      typeAction_legacy:
        actionTypeLabel,

      // NEW SYSTEM
      actionTypeId:
        actionTypeId || null,

      commentaire:
        commentaire || null,

      dateAction:
        dateAction || new Date(),

      statut:
        statut || "A faire",

      createdBy,
    });

    // ==============================
    // REMINDER
    // ==============================

    if (dateRelance) {

      await ProjectReminder.create({

        projectId,

        actionId:
          action.id,

        message:
          "Relance prévue",

        dateRelance,

        createdBy,
      });

      log.info(
        "reminder created",
        {
          actionId:
            action.id,

          dateRelance,
        }
      );
    }

    const actionWithReminder =
      await ProjectAction.findByPk(
        action.id,
        {
          include: [
            {
              model: ProjectReminder,
              as: "reminders",
            },
          ],
        }
      );

    log.info("action created", {
      actionId: action.id,
    });

    return res.status(201).json({
      success: true,
      data: actionWithReminder,
    });

  } catch (error) {

    console.error(
      "CREATE_ACTION_ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


// ==============================
// GET PROJECT ACTIONS
// ==============================
exports.getProjectActions = async (req, res) => {
  const { projectId } = req.params;

  try {
    if (!await assertProjectAccess(projectId, req, res)) return;

    const actions = await ProjectAction.findAll({
      where: { projectId },
      include: [{ model: ProjectReminder, as: "reminders" }],
      order: [["dateAction", "DESC"]],
    });

    return res.json({ success: true, data: actions });

  } catch (error) {
    log.error("getProjectActions failed", { projectId, message: error.message });
    return res.status(500).json({ success: false, message: "Failed to fetch project actions" });
  }
};


// ==============================
// GET TIMELINE CRM
// ==============================
exports.getTimeline = async (req, res) => {
  const { projectId } = req.params;

  try {
    if (!await assertProjectAccess(projectId, req, res)) return;

    const timeline = await ProjectAction.findAll({
      where: { projectId },
      include: [{ model: ProjectReminder, as: "reminders" }],
      order: [["dateAction", "ASC"]],
    });

    return res.json({ success: true, data: timeline });

  } catch (error) {
    log.error("getTimeline failed", { projectId, message: error.message });
    return res.status(500).json({ success: false, message: "Failed to fetch timeline" });
  }
};