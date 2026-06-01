const { sequelize } = require("../../../db");
const projectRepo = require("../repositories/project.repository");
const stageRepo = require("../../pipeline/repositories/pipelineStage.repository");
const actionTypeRepo = require("../../project-actions/repositories/projectActionType.repository");
const actionRepo = require("../../project-actions/repositories/projectAction.repository");
const { logActivity } = require("../../project-activities/services/projectActivity.service");
const { toProjectCard } = require("../../kanban/services/kanban.service");
const User = require("../../../models/User");

const SORTABLE = ["createdAt", "nomProjet", "montantMarche", "pourcentageReussite", "updatedAt"];

// ── List ──────────────────────────────────────────────────

async function listProjects(query, userId) {
  const limit = Math.min(parseInt(query.limit) || 20, 100);
  const page = Math.max(parseInt(query.page) || 1, 1);
  const offset = (page - 1) * limit;
  const sortBy = SORTABLE.includes(query.sortBy) ? query.sortBy : "createdAt";
  const sortDir = query.sortDir === "ASC" ? "ASC" : "DESC";

  const mine = query.mine === "true" || query.myProjects === "true";
  // Accept both ?ownerId=... and ?userId=... from any client
  const ownerId = query.ownerId || query.userId || null;

  console.log("=== USER FILTER ===");
  console.log("query.userId =", query.userId, "| query.ownerId =", query.ownerId, "| resolved ownerId =", ownerId);
  console.log("[listProjects] authUserId =", userId, "| mine =", mine);

  const filters = {
    mine,
    userId,
    stageId: query.stageId || null,
    projectModele: query.projectModele || null,
    search: query.search || null,
    isArchived: query.isArchived === "true",
    ownerId,
    dateFrom: query.dateFrom || null,
    dateTo: query.dateTo || null,
  };

  const [{ count, rows }, stats] = await Promise.all([
    projectRepo.findPaginated(filters, { limit, offset, sortBy, sortDir }),
    projectRepo.countStats(filters),
  ]);

  console.log("PROJECT COUNT AFTER FILTER");
  console.log("page count =", count, "| total =", stats.total, "| active =", stats.active, "| archived =", stats.archived);

  return {
    data: rows.map((r) => toProjectCard(r)),
    total: count,
    stats: {
      total: stats.total,
      active: stats.active,
      archived: stats.archived,
    },
    page,
    pages: Math.ceil(count / limit),
    limit,
  };
}

// ── Move Stage (Drag & Drop) ──────────────────────────────

async function moveStage(projectId, newStageId, userId) {
  const t = await sequelize.transaction();
  try {
    // Load current project (with stage for old-stage name)
    const project = await projectRepo.findById(projectId);
    if (!project) throw { status: 404, message: "Project not found" };

    const newStage = await stageRepo.findById(newStageId);
    if (!newStage) throw { status: 404, message: "Pipeline stage not found" };

    const oldStageId = project.pipelineStageId;
    const oldStageName = project.stage?.name || null;

    // ── 1. Update stage ────────────────────────────────────
    await projectRepo.update(projectId, { pipelineStageId: newStageId }, t);

    // ── 2. Log activity ────────────────────────────────────
    await logActivity(
      {
        projectId,
        userId,
        type: "stage_change",
        message: `Stage changé : "${oldStageName || "—"}" → "${newStage.name}"`,
        metadata: {
          fromStageId: oldStageId,
          fromStageName: oldStageName,
          toStageId: newStageId,
          toStageName: newStage.name,
          isWon: newStage.isWonStage,
          isLost: newStage.isLostStage,
        },
      },
      t
    );

    // ── 3. Auto-create action if stage requires it ─────────
    let autoAction = null;
    if (newStage.autoCreateAction) {
      const actionTypes = await actionTypeRepo.findByStageId(newStageId);
      if (actionTypes.length > 0) {
        autoAction = await actionRepo.create(
          {
            projectId,
            actionTypeId: actionTypes[0].id,
            commentaire: `Action automatique — ${newStage.name}`,
            dateAction: new Date(),
            statut: "A faire",
            createdBy: userId,
          },
          t
        );
      }
    }

    await t.commit();

    // ── 4. Return fresh project card with all updated data ─
    const updated = await projectRepo.findById(projectId);
    return {
      project: toProjectCard(updated),
      autoActionCreated: autoAction !== null,
      newStage: {
        id: newStage.id,
        name: newStage.name,
        color: newStage.color,
        isWonStage: newStage.isWonStage,
        isLostStage: newStage.isLostStage,
      },
    };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ── Assign Owner ──────────────────────────────────────────

async function assignOwner(projectId, ownerId, userId) {
  const t = await sequelize.transaction();
  try {
    const project = await projectRepo.findById(projectId);
    if (!project) throw { status: 404, message: "Project not found" };

    if (ownerId) {
      const owner = await User.findByPk(ownerId, { attributes: ["id"] });
      if (!owner) throw { status: 404, message: "User not found" };
    }

    const previousOwnerId = project.ownerId;
    await projectRepo.update(projectId, { ownerId: ownerId || null }, t);

    await logActivity(
      {
        projectId,
        userId,
        type: "edit",
        message: ownerId ? "Owner assigné" : "Owner retiré",
        metadata: { previousOwnerId, newOwnerId: ownerId || null },
      },
      t
    );

    await t.commit();

    const updated = await projectRepo.findById(projectId);
    return toProjectCard(updated);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = { listProjects, moveStage, assignOwner };
