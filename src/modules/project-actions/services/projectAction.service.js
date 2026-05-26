const { sequelize } = require("../../../db");
const actionRepo = require("../repositories/projectAction.repository");
const actionTypeRepo = require("../repositories/projectActionType.repository");
const Project = require("../../../models/Project");
const ProjectReminder = require("../../../models/ProjectReminder");
const { logActivity } = require("../../project-activities/services/projectActivity.service");

async function getProjectActions(projectId, query = {}) {
  const limit = Math.min(parseInt(query.limit) || 50, 200);
  const page = Math.max(parseInt(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const { count, rows } = await actionRepo.findByProject(projectId, { limit, offset });
  return {
    data: rows,
    total: count,
    page,
    pages: Math.ceil(count / limit),
  };
}

async function getActionById(id) {
  const action = await actionRepo.findById(id);
  if (!action) throw { status: 404, message: "Action not found" };
  return action;
}

async function createAction(projectId, body, userId) {
  // ── Guard: body must exist before any field access ────────────────────
  if (!body || typeof body !== "object") {
    throw { status: 400, message: "Request body is missing or invalid" };
  }

  console.log("BODY =", body);
  console.log("ACTION TYPE ID =", body?.actionTypeId);

  const t = await sequelize.transaction();

  try {
    const project = await Project.findByPk(projectId);
    if (!project) throw { status: 404, message: "Project not found" };

    // ── Resolve action type (new FK system takes priority) ───────────────
    let actionType = null;
    if (body?.actionTypeId) {
      actionType = await actionTypeRepo.findById(body.actionTypeId);
    }

    // ── Resolve legacy string (backward compat — never null in DB) ───────
    const legacyAction =
      body?.typeAction ||
      body?.typeAction_legacy ||
      body?.firstAction ||
      "Visite";

    console.log("LEGACY ACTION =", legacyAction);

    // ── Create action ─────────────────────────────────────────────────────
    const action = await actionRepo.create(
      {
        projectId,
        actionTypeId:       actionType?.id || null,
        typeAction_legacy:  legacyAction,
        commentaire:        body?.commentaire || null,
        dateAction:         body?.dateAction ? new Date(body.dateAction) : new Date(),
        dateRelance:        body?.dateRelance ? new Date(body.dateRelance) : null,
        statut:             body?.statut || "A faire",
        fileUrl:            body?.fileUrl || null,
        createdBy:          userId,
      },
      t
    );

    // ── Reminder ──────────────────────────────────────────────────────────
    if (body?.dateRelance) {
      await ProjectReminder.create(
        {
          projectId,
          actionId:   action.id,
          dateRelance: new Date(body.dateRelance),
          message:    body?.reminderMessage || `Relance - ${legacyAction}`,
          createdBy:  userId,
        },
        { transaction: t }
      );
    }

    // ── Update project lastRelanceAt ──────────────────────────────────────
    await Project.update(
      { lastRelanceAt: action.dateAction },
      { where: { id: projectId }, transaction: t }
    );

    // ── Activity log ──────────────────────────────────────────────────────
    await logActivity(
      {
        projectId,
        userId,
        type:    "action_created",
        message: `Action créée : ${legacyAction}`,
        metadata: { actionId: action.id, actionType: legacyAction },
      },
      t
    );

    await t.commit();
    return actionRepo.findById(action.id);

  } catch (err) {
    await t.rollback();
    console.error("CREATE_ACTION_ERROR:", err);
    throw err;
  }
}

async function updateAction(id, body, userId) {
  const t = await sequelize.transaction();
  try {
    const action = await actionRepo.findById(id);
    if (!action) throw { status: 404, message: "Action not found" };

    const updated = await actionRepo.update(id, body, t);
    await t.commit();
    return updated;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function deleteAction(id) {
  const t = await sequelize.transaction();
  try {
    const action = await actionRepo.findById(id);
    if (!action) throw { status: 404, message: "Action not found" };

    await actionRepo.destroy(id, t);
    await t.commit();
    return { deleted: true };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ── Action Types ──────────────────────────────────────────

async function getAllActionTypes() {
  return actionTypeRepo.findAll();
}

async function createActionType(data) {
  const existing = await actionTypeRepo.findByName(data.name);
  if (existing) throw { status: 409, message: "ActionType with this name already exists" };
  return actionTypeRepo.create({
    name: data.name.trim(),
    color: data.color || "#6366f1",
    icon: data.icon || null,
    linkedStageId: data.linkedStageId || null,
  });
}

async function updateActionType(id, data) {
  const existing = await actionTypeRepo.findById(id);
  if (!existing) throw { status: 404, message: "ActionType not found" };
  if (data.name) {
    const conflict = await actionTypeRepo.findByName(data.name);
    if (conflict && conflict.id !== id) {
      throw { status: 409, message: "ActionType with this name already exists" };
    }
  }
  return actionTypeRepo.update(id, data);
}

async function deleteActionType(id) {
  const existing = await actionTypeRepo.findById(id);
  if (!existing) throw { status: 404, message: "ActionType not found" };
  await actionTypeRepo.destroy(id);
  return { deleted: true };
}

module.exports = {
  getProjectActions,
  getActionById,
  createAction,
  updateAction,
  deleteAction,
  getAllActionTypes,
  createActionType,
  updateActionType,
  deleteActionType,
};
