"use strict";

const { sequelize } = require("../../../db");
const { Op } = require("sequelize");
const Project         = require("../../../models/Project");
const PipelineStage   = require("../../../models/PipelineStage");
const ProjectActivity = require("../../../models/ProjectActivity");
const ProjectAction   = require("../../../models/ProjectAction");
const User            = require("../../../models/User");
const Notification    = require("../../../models/Notification");

const ADMIN_ROLES = ["admin", "superadmin"];

// ─── Legacy KPI (GET /dashboard/kpis) ────────────────────────────────────────

async function getKPIs(userId, role) {
  const isAdmin       = ADMIN_ROLES.includes(role);
  const projectFilter = isAdmin ? { isArchived: false } : { isArchived: false, ownerId: userId };
  const ownerClause   = isAdmin ? "" : `AND p."ownerId" = :userId`;

  const totalProjects = await Project.count({ where: projectFilter });

  const wonProjects = await Project.count({
    where: projectFilter,
    include: [{ model: PipelineStage, as: "stage", where: { isWonStage: true }, required: true }],
  });

  const lostProjects = await Project.count({
    where: projectFilter,
    include: [{ model: PipelineStage, as: "stage", where: { isLostStage: true }, required: true }],
  });

  const activeProjects = totalProjects - wonProjects - lostProjects;

  const [revenueRow] = await sequelize.query(
    `SELECT COALESCE(SUM(p."montantMarche"), 0) AS total
     FROM projects p
     INNER JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
     WHERE ps."isWonStage" = true AND p."isArchived" = false ${ownerClause}`,
    { replacements: { userId }, type: "SELECT" }
  );
  const totalRevenue = parseFloat(revenueRow?.total || 0);

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [monthlyRow] = await sequelize.query(
    `SELECT COALESCE(SUM(p."montantMarche"), 0) AS total
     FROM projects p
     INNER JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
     WHERE ps."isWonStage" = true AND p."isArchived" = false AND p."createdAt" >= :startOfMonth ${ownerClause}`,
    { replacements: { userId, startOfMonth }, type: "SELECT" }
  );
  const monthlyRevenue = parseFloat(monthlyRow?.total || 0);

  const conversionRate =
    totalProjects > 0 ? Math.round((wonProjects / totalProjects) * 10000) / 100 : 0;

  const activitiesCount = await ProjectActivity.count();

  const actionsCount = await ProjectAction.count({
    where: { statut: "A faire" },
    include: [{ model: Project, as: "project", where: projectFilter, required: true, attributes: [] }],
  });

  const projectsByStage = await sequelize.query(
    `SELECT ps.id, ps.name, ps.color, ps.position, ps."isWonStage", ps."isLostStage",
            COUNT(p.id)::int AS count,
            COALESCE(SUM(p."montantMarche"), 0)::float AS revenue
     FROM pipeline_stages ps
     LEFT JOIN projects p ON p."pipelineStageId" = ps.id AND p."isArchived" = false ${ownerClause}
     WHERE ps."deletedAt" IS NULL
     GROUP BY ps.id, ps.name, ps.color, ps.position, ps."isWonStage", ps."isLostStage"
     ORDER BY ps.position`,
    { replacements: { userId }, type: "SELECT" }
  );

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const monthlyTrend = await sequelize.query(
    `SELECT TO_CHAR(DATE_TRUNC('month', p."createdAt"), 'YYYY-MM') AS month,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ps."isWonStage" = true)::int AS won,
            COALESCE(SUM(p."montantMarche") FILTER (WHERE ps."isWonStage" = true), 0)::float AS revenue
     FROM projects p
     LEFT JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
     WHERE p."createdAt" >= :sixMonthsAgo AND p."isArchived" = false ${ownerClause}
     GROUP BY DATE_TRUNC('month', p."createdAt")
     ORDER BY DATE_TRUNC('month', p."createdAt")`,
    { replacements: { userId, sixMonthsAgo }, type: "SELECT" }
  );

  return {
    counts: { totalProjects, wonProjects, lostProjects, activeProjects, pendingActions: actionsCount },
    revenue: { total: totalRevenue, monthly: monthlyRevenue },
    rates: { conversionRate },
    activitiesCount,
    projectsByStage,
    monthlyTrend,
  };
}

// ─── Admin KPIs (GET /dashboard/kpi) ─────────────────────────────────────────

async function getAdminKPIs() {
  const now = new Date();

  const [
    totalProjects, totalUsers, totalApplicateurs, totalRevendeurs,
    totalValidated, totalNonValidated, totalArchived, totalPending,
  ] = await Promise.all([
    Project.count({ where: { isArchived: false } }),
    User.count(),
    Project.count({ where: { isArchived: false, projectModele: "applicateur" } }),
    Project.count({ where: { isArchived: false, projectModele: "revendeur" } }),
    Project.count({ where: { isArchived: false, validationStatut: "Validé" } }),
    Project.count({ where: { isArchived: false, validationStatut: "Non validé" } }),
    Project.count({ where: { isArchived: true } }),
    Project.count({ where: { isArchived: false, statut: { [Op.notIn]: ["Gagné", "Perdu"] } } }),
  ]);

  const validationRate =
    totalProjects > 0 ? Math.round((totalValidated / totalProjects) * 10000) / 100 : 0;

  const [surfaceRow] = await sequelize.query(
    `SELECT COALESCE(SUM("surfaceProspectee"), 0) AS total FROM projects WHERE "isArchived" = false`,
    { type: "SELECT" }
  );
  const totalSurface = parseFloat(surfaceRow?.total || 0);

  const [topUsers, topRevendeurs, topApplicateurs, statusDistribution, monthlyEvolution] =
    await Promise.all([
      sequelize.query(
        `SELECT p."ownerId" AS "userId", COUNT(p.id)::int AS count,
                u.email, up.name, up."avatarUrl"
         FROM projects p
         INNER JOIN users u ON u.id = p."ownerId"
         LEFT  JOIN user_profiles up ON up."userId" = u.id
         WHERE p."isArchived" = false
         GROUP BY p."ownerId", u.email, up.name, up."avatarUrl"
         ORDER BY count DESC LIMIT 5`,
        { type: "SELECT" }
      ),
      sequelize.query(
        `SELECT p."ownerId" AS "userId", COUNT(p.id)::int AS count,
                u.email, up.name, up."avatarUrl"
         FROM projects p
         INNER JOIN users u ON u.id = p."ownerId"
         LEFT  JOIN user_profiles up ON up."userId" = u.id
         WHERE p."isArchived" = false AND p."projectModele" = 'revendeur'
         GROUP BY p."ownerId", u.email, up.name, up."avatarUrl"
         ORDER BY count DESC LIMIT 5`,
        { type: "SELECT" }
      ),
      sequelize.query(
        `SELECT p."ownerId" AS "userId", COUNT(p.id)::int AS count,
                u.email, up.name, up."avatarUrl"
         FROM projects p
         INNER JOIN users u ON u.id = p."ownerId"
         LEFT  JOIN user_profiles up ON up."userId" = u.id
         WHERE p."isArchived" = false AND p."projectModele" = 'applicateur'
         GROUP BY p."ownerId", u.email, up.name, up."avatarUrl"
         ORDER BY count DESC LIMIT 5`,
        { type: "SELECT" }
      ),
      sequelize.query(
        `SELECT COALESCE(statut, 'Sans statut') AS statut, COUNT(*)::int AS count
         FROM projects WHERE "isArchived" = false
         GROUP BY statut ORDER BY count DESC`,
        { type: "SELECT" }
      ),
      (function () {
        const ago = new Date(now);
        ago.setMonth(ago.getMonth() - 11);
        ago.setDate(1);
        ago.setHours(0, 0, 0, 0);
        return sequelize.query(
          `SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') AS month,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE "validationStatut" = 'Validé')::int AS validated,
                  COUNT(*) FILTER (WHERE "isArchived" = true)::int            AS archived,
                  COALESCE(SUM("surfaceProspectee"), 0)::float                AS surface
           FROM projects WHERE "createdAt" >= :ago
           GROUP BY DATE_TRUNC('month', "createdAt")
           ORDER BY DATE_TRUNC('month', "createdAt")`,
          { replacements: { ago }, type: "SELECT" }
        );
      })(),
    ]);

  return {
    role: "admin",
    stats: {
      totalProjects, totalUsers, totalApplicateurs, totalRevendeurs,
      totalValidated, totalNonValidated, totalArchived, totalPending,
      validationRate, totalSurface,
    },
    charts: { statusDistribution, monthlyEvolution },
    topUsers,
    topRevendeurs,
    topApplicateurs,
  };
}

// ─── User KPIs (GET /dashboard/kpi) ──────────────────────────────────────────

async function getUserKPIs(userId) {
  const now = new Date();

  const [myProjects, myValidated, myNonValidated, myArchived, myPending] = await Promise.all([
    Project.count({ where: { ownerId: userId, isArchived: false } }),
    Project.count({ where: { ownerId: userId, isArchived: false, validationStatut: "Validé" } }),
    Project.count({ where: { ownerId: userId, isArchived: false, validationStatut: "Non validé" } }),
    Project.count({ where: { ownerId: userId, isArchived: true } }),
    Project.count({ where: { ownerId: userId, isArchived: false, statut: { [Op.notIn]: ["Gagné", "Perdu"] } } }),
  ]);

  const myValidationRate =
    myProjects > 0 ? Math.round((myValidated / myProjects) * 10000) / 100 : 0;

  const [surfaceRow] = await sequelize.query(
    `SELECT COALESCE(SUM("surfaceProspectee"), 0) AS total
     FROM projects WHERE "ownerId" = :userId AND "isArchived" = false`,
    { replacements: { userId }, type: "SELECT" }
  );
  const mySurface = parseFloat(surfaceRow?.total || 0);

  const [relanceRow] = await sequelize.query(
    `SELECT COUNT(*)::int AS count
     FROM project_reminders pr
     INNER JOIN projects p ON p.id = pr."projectId"
     WHERE p."ownerId" = :userId AND pr."dateRelance" >= NOW()`,
    { replacements: { userId }, type: "SELECT" }
  );
  const myRelances = Number(relanceRow?.count || 0);

  const recentRows = await Project.findAll({
    where: { ownerId: userId },
    order: [["createdAt", "DESC"]],
    limit: 10,
    attributes: ["id", "nomProjet", "projectModele", "statut", "validationStatut", "isArchived", "createdAt", "surfaceProspectee"],
  });

  const ago = new Date(now);
  ago.setMonth(ago.getMonth() - 11);
  ago.setDate(1);
  ago.setHours(0, 0, 0, 0);

  const [myMonthlyEvolution, myStatusDistribution] = await Promise.all([
    sequelize.query(
      `SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') AS month,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE "validationStatut" = 'Validé')::int AS validated
       FROM projects WHERE "ownerId" = :userId AND "createdAt" >= :ago
       GROUP BY DATE_TRUNC('month', "createdAt")
       ORDER BY DATE_TRUNC('month', "createdAt")`,
      { replacements: { userId, ago }, type: "SELECT" }
    ),
    sequelize.query(
      `SELECT COALESCE(statut, 'Sans statut') AS statut, COUNT(*)::int AS count
       FROM projects WHERE "ownerId" = :userId AND "isArchived" = false
       GROUP BY statut ORDER BY count DESC`,
      { replacements: { userId }, type: "SELECT" }
    ),
  ]);

  return {
    role: "user",
    stats: {
      myProjects, myValidated, myNonValidated, myArchived, myPending,
      myValidationRate, mySurface, myRelances,
    },
    charts: { myStatusDistribution, myMonthlyEvolution },
    recentProjects: recentRows.map((p) => p.toJSON()),
    topUsers: [],
    topRevendeurs: [],
    topApplicateurs: [],
  };
}

async function getKPIByRole(userId, role) {
  return ADMIN_ROLES.includes(role) ? getAdminKPIs() : getUserKPIs(userId);
}

// ─── Professional Dashboard (GET /dashboard/professional) ────────────────────

async function getProfessionalKPIs(userId, role) {
  const isAdmin       = ADMIN_ROLES.includes(role);
  const ownerWhere    = isAdmin ? {} : { ownerId: userId };
  // Two SQL clause variants — used in queries with/without table alias
  const ownerClause   = isAdmin ? "" : `AND "ownerId" = :userId`;
  const ownerClauseP  = isAdmin ? "" : `AND p."ownerId" = :userId`;

  const now = new Date();

  // ── 1. Summary counts (all parallel) ─────────────────────────
  const [
    totalProjects,
    archivedProjects,
    pendingProjects,
    totalValidated,
    wonProjectsCount,
  ] = await Promise.all([
    Project.count({ where: { ...ownerWhere, isArchived: false } }),
    Project.count({ where: { ...ownerWhere, isArchived: true } }),
    Project.count({ where: { ...ownerWhere, isArchived: false, statut: { [Op.notIn]: ["Gagné", "Perdu"] } } }),
    Project.count({ where: { ...ownerWhere, isArchived: false, validationStatut: "Validé" } }),
    Project.count({
      where: { ...ownerWhere, isArchived: false },
      include: [{ model: PipelineStage, as: "stage", where: { isWonStage: true }, required: true }],
    }),
  ]);

  const activeProjects  = totalProjects;
  const validationRate  = totalProjects > 0 ? Math.round((totalValidated  / totalProjects) * 10000) / 100 : 0;
  const successRate     = totalProjects > 0 ? Math.round((wonProjectsCount / totalProjects) * 10000) / 100 : 0;

  // ── 2. Performance (all parallel) ────────────────────────────
  const ago12 = new Date(now);
  ago12.setMonth(ago12.getMonth() - 11);
  ago12.setDate(1);
  ago12.setHours(0, 0, 0, 0);

  const [monthlyEvolution, projectsByStatus, projectsByType] = await Promise.all([
    sequelize.query(
      `SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') AS month,
              COUNT(*)::int                                                        AS total,
              COUNT(*) FILTER (WHERE "validationStatut" = 'Validé')::int          AS validated,
              COUNT(*) FILTER (WHERE "isArchived" = true)::int                    AS archived,
              COALESCE(SUM("surfaceProspectee"), 0)::float                        AS surface
       FROM projects
       WHERE "createdAt" >= :ago12 ${ownerClause}
       GROUP BY DATE_TRUNC('month', "createdAt")
       ORDER BY DATE_TRUNC('month', "createdAt")`,
      { replacements: { ago12, userId }, type: "SELECT" }
    ),
    sequelize.query(
      `SELECT COALESCE(statut, 'Sans statut') AS statut, COUNT(*)::int AS count
       FROM projects WHERE "isArchived" = false ${ownerClause}
       GROUP BY statut ORDER BY count DESC`,
      { replacements: { userId }, type: "SELECT" }
    ),
    sequelize.query(
      `SELECT "projectModele" AS type, COUNT(*)::int AS count
       FROM projects WHERE "isArchived" = false ${ownerClause}
       GROUP BY "projectModele" ORDER BY count DESC`,
      { replacements: { userId }, type: "SELECT" }
    ),
  ]);

  // projectsByOwner — admin: top 10; user: self only
  let projectsByOwner = [];
  if (isAdmin) {
    projectsByOwner = await sequelize.query(
      `SELECT p."ownerId" AS "userId", COUNT(p.id)::int AS count,
              u.email, up.name, up."avatarUrl"
       FROM projects p
       INNER JOIN users u ON u.id = p."ownerId"
       LEFT  JOIN user_profiles up ON up."userId" = u.id
       WHERE p."isArchived" = false
       GROUP BY p."ownerId", u.email, up.name, up."avatarUrl"
       ORDER BY count DESC LIMIT 10`,
      { type: "SELECT" }
    );
  } else {
    const [self] = await sequelize.query(
      `SELECT p."ownerId" AS "userId", COUNT(p.id)::int AS count,
              u.email, up.name, up."avatarUrl"
       FROM projects p
       INNER JOIN users u ON u.id = p."ownerId"
       LEFT  JOIN user_profiles up ON up."userId" = u.id
       WHERE p."isArchived" = false AND p."ownerId" = :userId
       GROUP BY p."ownerId", u.email, up.name, up."avatarUrl"`,
      { replacements: { userId }, type: "SELECT" }
    );
    if (self) projectsByOwner = [self];
  }

  // ── 3. Pipeline ───────────────────────────────────────────────
  const stages = await sequelize.query(
    `SELECT ps.id, ps.name, ps.color, ps.icon, ps.position,
            ps."isWonStage", ps."isLostStage",
            COUNT(p.id)::int                             AS count,
            COALESCE(SUM(p."montantMarche"), 0)::float   AS revenue
     FROM pipeline_stages ps
     LEFT JOIN projects p
       ON p."pipelineStageId" = ps.id
      AND p."isArchived" = false ${ownerClauseP}
     WHERE ps."deletedAt" IS NULL
     GROUP BY ps.id, ps.name, ps.color, ps.icon, ps.position, ps."isWonStage", ps."isLostStage"
     ORDER BY ps.position`,
    { replacements: { userId }, type: "SELECT" }
  );

  const totalInPipeline = stages.reduce((s, st) => s + Number(st.count), 0);
  const wonInPipeline   = stages.filter((st) => st.isWonStage).reduce((s, st) => s + Number(st.count), 0);
  const lostInPipeline  = stages.filter((st) => st.isLostStage).reduce((s, st) => s + Number(st.count), 0);

  const conversions = {
    total:          totalInPipeline,
    won:            wonInPipeline,
    lost:           lostInPipeline,
    active:         totalInPipeline - wonInPipeline - lostInPipeline,
    conversionRate: totalInPipeline > 0
      ? Math.round((wonInPipeline / totalInPipeline) * 10000) / 100
      : 0,
  };

  const opportunities = await sequelize.query(
    `SELECT p.id, p."nomProjet", p."montantMarche", p."statut", p."createdAt",
            ps.name AS "stageName", ps.color AS "stageColor", ps.position AS "stagePosition",
            u.email AS "ownerEmail", up.name AS "ownerName"
     FROM projects p
     LEFT  JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
     LEFT  JOIN users u            ON u.id  = p."ownerId"
     LEFT  JOIN user_profiles up   ON up."userId" = u.id
     WHERE p."isArchived" = false
       AND (ps."isWonStage"  IS NULL OR ps."isWonStage"  = false)
       AND (ps."isLostStage" IS NULL OR ps."isLostStage" = false)
       ${ownerClauseP}
     ORDER BY p."createdAt" DESC LIMIT 20`,
    { replacements: { userId }, type: "SELECT" }
  );

  // ── 4. Maps ───────────────────────────────────────────────────
  const [locRow] = await sequelize.query(
    `SELECT COUNT(*)::int AS count FROM projects
     WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL
       AND "isArchived" = false ${ownerClause}`,
    { replacements: { userId }, type: "SELECT" }
  );

  const geolocalizedProjects = await sequelize.query(
    `SELECT id, "nomProjet", "latitude"::float, "longitude"::float,
            "statut", "validationStatut", "adresse", "projectModele"
     FROM projects
     WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL
       AND "isArchived" = false ${ownerClause}
     ORDER BY "createdAt" DESC LIMIT 200`,
    { replacements: { userId }, type: "SELECT" }
  );

  // ── 5. Alerts (all parallel) ──────────────────────────────────
  const [overdueRow, missingDocsRow, missingValRow, unreadNotifications] = await Promise.all([
    sequelize.query(
      `SELECT COUNT(*)::int AS count FROM projects
       WHERE "isArchived" = false
         AND "nextRelanceDate" IS NOT NULL
         AND "nextRelanceDate" < NOW() ${ownerClause}`,
      { replacements: { userId }, type: "SELECT" }
    ).then(([r]) => r),
    sequelize.query(
      `SELECT COUNT(DISTINCT p.id)::int AS count
       FROM projects p
       WHERE p."isArchived" = false
         AND NOT EXISTS (
           SELECT 1 FROM project_actions pa
           WHERE pa."projectId" = p.id
             AND pa."fileUrl" IS NOT NULL
             AND pa."fileUrl" <> ''
         ) ${ownerClauseP}`,
      { replacements: { userId }, type: "SELECT" }
    ).then(([r]) => r),
    sequelize.query(
      `SELECT COUNT(*)::int AS count FROM projects
       WHERE "isArchived" = false AND "validationStatut" = 'Non validé' ${ownerClause}`,
      { replacements: { userId }, type: "SELECT" }
    ).then(([r]) => r),
    Notification.count({ where: { userId, isRead: false } }),
  ]);

  // ── Build & log response ──────────────────────────────────────
  const response = {
    summary: {
      totalProjects,
      activeProjects,
      archivedProjects,
      pendingProjects,
      validationRate,
      successRate,
    },
    performance: {
      monthlyEvolution,
      projectsByStatus,
      projectsByOwner,
      projectsByType,
    },
    pipeline: {
      stages,
      conversions,
      opportunities,
    },
    maps: {
      totalLocations:       Number(locRow?.count || 0),
      geolocalizedProjects,
    },
    alerts: {
      overdueProjects:      Number(overdueRow?.count      || 0),
      missingDocuments:     Number(missingDocsRow?.count  || 0),
      missingValidation:    Number(missingValRow?.count   || 0),
      unreadNotifications,
    },
  };

  console.log("KPI RESPONSE", JSON.stringify({
    role,
    userId,
    summary:    response.summary,
    pipelineConversions: response.pipeline.conversions,
    alerts:     response.alerts,
  }));

  return response;
}

module.exports = { getKPIs, getKPIByRole, getProfessionalKPIs };
