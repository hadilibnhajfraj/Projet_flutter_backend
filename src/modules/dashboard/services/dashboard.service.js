const { sequelize } = require("../../../db");
const { Op } = require("sequelize");
const Project = require("../../../models/Project");
const PipelineStage = require("../../../models/PipelineStage");
const ProjectActivity = require("../../../models/ProjectActivity");
const ProjectAction = require("../../../models/ProjectAction");

const ADMIN_ROLES = ["admin", "superadmin"];

async function getKPIs(userId, role) {
  const isAdmin = ADMIN_ROLES.includes(role);
  const projectFilter = isAdmin ? { isArchived: false } : { isArchived: false, ownerId: userId };

  // ── 1. Counts ─────────────────────────────────────────────
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

  // ── 2. Revenue — parameterized to prevent SQL injection ───
  const ownerClause = isAdmin ? "" : `AND p."ownerId" = :userId`;

  const [revenueRow] = await sequelize.query(
    `SELECT COALESCE(SUM(p."montantMarche"), 0) AS total
     FROM projects p
     INNER JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
     WHERE ps."isWonStage" = true
       AND p."isArchived" = false
       ${ownerClause}`,
    { replacements: { userId }, type: "SELECT" }
  );
  const totalRevenue = parseFloat(revenueRow?.total || 0);

  // Monthly revenue — current calendar month
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const [monthlyRow] = await sequelize.query(
    `SELECT COALESCE(SUM(p."montantMarche"), 0) AS total
     FROM projects p
     INNER JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
     WHERE ps."isWonStage" = true
       AND p."isArchived" = false
       AND p."createdAt" >= :startOfMonth
       ${ownerClause}`,
    { replacements: { userId, startOfMonth }, type: "SELECT" }
  );
  const monthlyRevenue = parseFloat(monthlyRow?.total || 0);

  // ── 3. Conversion rate ────────────────────────────────────
  const conversionRate =
    totalProjects > 0 ? Math.round((wonProjects / totalProjects) * 10000) / 100 : 0;

  // ── 4. Activities / pending actions ──────────────────────
  const activitiesCount = await ProjectActivity.count();

  const actionsCount = await ProjectAction.count({
    where: { statut: "A faire" },
    include: [
      {
        model: Project,
        as: "project",
        where: projectFilter,
        required: true,
        attributes: [],
      },
    ],
  });

  // ── 5. Projects by stage (funnel) ─────────────────────────
  const projectsByStage = await sequelize.query(
    `SELECT ps.id, ps.name, ps.color, ps.position, ps."isWonStage", ps."isLostStage",
            COUNT(p.id)::int AS count,
            COALESCE(SUM(p."montantMarche"), 0)::float AS revenue
     FROM pipeline_stages ps
     LEFT JOIN projects p
       ON p."pipelineStageId" = ps.id
       AND p."isArchived" = false
       ${ownerClause}
     WHERE ps."deletedAt" IS NULL
     GROUP BY ps.id, ps.name, ps.color, ps.position, ps."isWonStage", ps."isLostStage"
     ORDER BY ps.position`,
    { replacements: { userId }, type: "SELECT" }
  );

  // ── 6. Monthly trend — last 6 months ─────────────────────
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const monthlyTrend = await sequelize.query(
    `SELECT TO_CHAR(DATE_TRUNC('month', p."createdAt"), 'YYYY-MM') AS month,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE ps."isWonStage" = true
            )::int AS won,
            COALESCE(SUM(p."montantMarche") FILTER (
              WHERE ps."isWonStage" = true
            ), 0)::float AS revenue
     FROM projects p
     LEFT JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
     WHERE p."createdAt" >= :sixMonthsAgo
       AND p."isArchived" = false
       ${ownerClause}
     GROUP BY DATE_TRUNC('month', p."createdAt")
     ORDER BY DATE_TRUNC('month', p."createdAt")`,
    { replacements: { userId, sixMonthsAgo }, type: "SELECT" }
  );

  return {
    counts: {
      totalProjects,
      wonProjects,
      lostProjects,
      activeProjects,
      pendingActions: actionsCount,
    },
    revenue: {
      total: totalRevenue,
      monthly: monthlyRevenue,
    },
    rates: {
      conversionRate,
    },
    activitiesCount,
    projectsByStage,
    monthlyTrend,
  };
}

module.exports = { getKPIs };
