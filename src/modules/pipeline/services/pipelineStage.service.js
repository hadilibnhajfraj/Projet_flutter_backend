const { sequelize } = require("../../../db");
const repo = require("../repositories/pipelineStage.repository");
const actionTypeRepo = require("../../project-actions/repositories/projectActionType.repository");
const Project = require("../../../models/Project");

async function getAllStages() {
  return repo.findAll();
}

async function getStageById(id) {
  const stage = await repo.findById(id);
  if (!stage) throw { status: 404, message: "Stage not found" };
  return stage;
}

async function createStage(data, userId) {
  const t = await sequelize.transaction();
  try {
    const existing = await repo.findByName(data.name);
    if (existing) throw { status: 409, message: "A stage with this name already exists" };

    const maxPos = await repo.getMaxPosition();
    const stage = await repo.create(
      {
        name: data.name.trim(),
        color: data.color || "#6366f1",
        icon: data.icon || null,
        position: data.position !== undefined ? Number(data.position) : maxPos + 1,
        isDefault: Boolean(data.isDefault),
        isWonStage: Boolean(data.isWonStage),
        isLostStage: Boolean(data.isLostStage),
        autoCreateAction: Boolean(data.autoCreateAction),
        isCustom: data.isCustom !== undefined ? Boolean(data.isCustom) : true,
        createdBy: userId || null,
      },
      t
    );

    if (stage.autoCreateAction) {
      await actionTypeRepo.create(
        {
          name: `Action - ${stage.name}`,
          color: stage.color,
          icon: stage.icon,
          linkedStageId: stage.id,
        },
        t
      );
    }

    await t.commit();
    return repo.findById(stage.id);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function updateStage(id, data, userId) {
  const t = await sequelize.transaction();
  try {
    const stage = await repo.findById(id);
    if (!stage) throw { status: 404, message: "Stage not found" };

    if (data.name) {
      const conflict = await repo.findByName(data.name);
      if (conflict && conflict.id !== id) {
        throw { status: 409, message: "A stage with this name already exists" };
      }
      data.name = data.name.trim();
    }

    const updated = await repo.update(id, data, t);
    await t.commit();
    return updated;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function deleteStage(id) {
  const t = await sequelize.transaction();
  try {
    const stage = await repo.findById(id);
    if (!stage) throw { status: 404, message: "Stage not found" };

    const count = await Project.count({ where: { pipelineStageId: id } });
    if (count > 0) {
      throw {
        status: 409,
        message: `Cannot delete: ${count} project(s) are assigned to this stage`,
      };
    }

    // paranoid: true → sets deletedAt, does NOT hard-delete
    await repo.destroy(id, t);
    await t.commit();
    return { deleted: true };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function reorderStages(stages) {
  const t = await sequelize.transaction();
  try {
    await Promise.all(
      stages.map(({ id, position }) => repo.update(id, { position: Number(position) }, t))
    );
    await t.commit();
    return repo.findAll();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = {
  getAllStages,
  getStageById,
  createStage,
  updateStage,
  deleteStage,
  reorderStages,
};
