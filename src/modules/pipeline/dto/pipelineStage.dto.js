/**
 * Strips internal Sequelize fields and normalises a PipelineStage for API responses.
 */
function toStageResponse(stage) {
  if (!stage) return null;
  const s = stage.toJSON ? stage.toJSON() : stage;
  return {
    id: s.id,
    name: s.name,
    color: s.color,
    icon: s.icon,
    position: s.position,
    isDefault: s.isDefault,
    isWonStage: s.isWonStage,
    isLostStage: s.isLostStage,
    autoCreateAction: s.autoCreateAction,
    createdBy: s.createdBy,
    actionTypes: (s.actionTypes || []).map((at) => ({
      id: at.id,
      name: at.name,
      color: at.color,
      icon: at.icon,
    })),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function toStageList(stages) {
  return stages.map(toStageResponse);
}

module.exports = { toStageResponse, toStageList };
