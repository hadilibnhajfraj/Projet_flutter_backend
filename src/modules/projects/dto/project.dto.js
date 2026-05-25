/**
 * Project DTO — standardised API response shapes.
 */
function toOwnerRef(user) {
  if (!user) return null;
  const u = user.toJSON ? user.toJSON() : user;
  const profile = u.profile || {};
  return {
    id: u.id,
    email: u.email,
    name:
      profile.firstName || profile.lastName
        ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim()
        : u.email,
    avatar: profile.avatar || null,
  };
}

function toStageRef(stage) {
  if (!stage) return null;
  const s = stage.toJSON ? stage.toJSON() : stage;
  return {
    id: s.id,
    name: s.name,
    color: s.color,
    icon: s.icon,
    position: s.position,
    isWonStage: s.isWonStage,
    isLostStage: s.isLostStage,
  };
}

function toProjectCard(project, extra = {}) {
  const p = project.toJSON ? project.toJSON() : project;
  return {
    id: p.id,
    nomProjet: p.nomProjet,
    typeProjet: p.typeProjet,
    projectModele: p.projectModele,
    stage: toStageRef(p.stage),
    owner: toOwnerRef(p.owner),
    successRate: p.pourcentageReussite !== null ? parseFloat(p.pourcentageReussite) : null,
    montantMarche: p.montantMarche !== null ? parseFloat(p.montantMarche) : null,
    adresse: p.adresse || null,
    isArchived: p.isArchived,
    lastRelanceAt: p.lastRelanceAt,
    createdAt: p.createdAt,
    ...extra,
  };
}

function toProjectList(rows, extra = {}) {
  return rows.map((r) => toProjectCard(r, extra));
}

module.exports = { toProjectCard, toProjectList, toOwnerRef, toStageRef };
