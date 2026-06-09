"use strict";

const express = require("express");
const { sequelize } = require("../db");
const { authRequired }  = require("../middleware/auth.middleware");
const { kpiRoleGuard }  = require("../middleware/kpiRoleGuard");

const router = express.Router();

const ADMIN_ROLES = ["admin", "superadmin"];

// ══════════════════════════════════════════════════════════════════════════════
// GET /crm/kpi/global — KPI globaux plateforme (admin / superadmin uniquement)
// ══════════════════════════════════════════════════════════════════════════════
router.get("/kpi/global", authRequired, kpiRoleGuard, async (req, res) => {
  try {
    const rows = await sequelize.query(
      `SELECT
         (SELECT COUNT(*)::int  FROM projects     WHERE "isArchived" = false)            AS "totalProjects",
         (SELECT COUNT(*)::int  FROM projects     WHERE "isArchived" = false
           AND "validationStatut" = 'Validé')                                            AS "validatedProjects",
         (SELECT COUNT(*)::int  FROM users        WHERE "isActive"   = true)             AS "activeUsers",
         (SELECT COUNT(*)::int  FROM users)                                               AS "totalUsers",
         (SELECT COALESCE(SUM(p."montantMarche"), 0)::float
            FROM projects p
            JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
            WHERE ps."isWonStage" = true AND p."isArchived" = false)                     AS "totalRevenue"`,
      { type: "SELECT" }
    );
    const data = rows[0] ?? {};
    res.json({ success: true, data });
  } catch (err) {
    console.error("CRM_KPI_GLOBAL_ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /crm/kpi/projects — KPI projets par étape pipeline (admin / superadmin)
// ══════════════════════════════════════════════════════════════════════════════
router.get("/kpi/projects", authRequired, kpiRoleGuard, async (req, res) => {
  try {
    const data = await sequelize.query(
      `SELECT
         ps.name                                    AS stage,
         ps.color,
         ps."isWonStage",
         ps."isLostStage",
         COUNT(p.id)::int                           AS count,
         COALESCE(SUM(p."montantMarche"), 0)::float AS revenue
       FROM pipeline_stages ps
       LEFT JOIN projects p
         ON p."pipelineStageId" = ps.id AND p."isArchived" = false
       WHERE ps."deletedAt" IS NULL
       GROUP BY ps.id, ps.name, ps.color, ps.position, ps."isWonStage", ps."isLostStage"
       ORDER BY ps.position`,
      { type: "SELECT" }
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error("CRM_KPI_PROJECTS_ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /crm/kpi/users — Performance par utilisateur (admin / superadmin)
// ══════════════════════════════════════════════════════════════════════════════
router.get("/kpi/users", authRequired, kpiRoleGuard, async (req, res) => {
  try {
    const data = await sequelize.query(
      `SELECT
         u.id,
         u.email,
         u.role,
         u."isActive",
         COUNT(p.id)::int                                                     AS "totalProjects",
         COUNT(p.id) FILTER (WHERE p."isArchived" = false)::int              AS "activeProjects",
         COUNT(p.id) FILTER (WHERE p."validationStatut" = 'Validé')::int     AS "validatedProjects",
         COALESCE(SUM(p."montantMarche") FILTER (
           WHERE p."isArchived" = false
         ), 0)::float                                                         AS "totalRevenue"
       FROM users u
       LEFT JOIN projects p ON p."ownerId" = u.id
       GROUP BY u.id, u.email, u.role, u."isActive"
       ORDER BY "activeProjects" DESC`,
      { type: "SELECT" }
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error("CRM_KPI_USERS_ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /crm/upcoming-followups
 *
 * Returns one entry per project that needs a follow-up.
 * count = unique projects needing attention (not rows in project_reminders).
 *
 * Primary date priority per project:
 *   1. earliest project_reminder.dateRelance in window
 *   2. earliest project_actions.dateRelance  in window (not already covered by a reminder)
 *   3. projects.nextRelanceDate
 *   4. null (admin only — project has no date scheduled → classified as overdue)
 *
 * Role filter:
 *   user        → active projects WHERE ownerId = req.user.sub
 *   admin       → all active projects NOT in a won/lost pipeline stage
 *   superadmin  → same as admin (ownerFilter = null)
 *
 * Query params:
 *   days=30   forward look-ahead window (default 30, max 365)
 */
router.get("/upcoming-followups", authRequired, async (req, res) => {
  try {
    const userId  = req.user.sub;
    const role    = (req.user.role || "").toLowerCase().trim();
    const isAdmin = ADMIN_ROLES.includes(role);

    console.log("ROLE =",         role);
    console.log("USER_ID =",      userId);
    console.log("IS_ADMIN =",     isAdmin);
    console.log("OWNER_FILTER =", isAdmin ? null : userId);

    const days      = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(),  0,  0,  0,   0);
    const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const windowEnd  = new Date(todayStart);
    windowEnd.setDate(windowEnd.getDate() + days);
    // look 90 days back to capture overdue items
    const fromDate = new Date(todayStart);
    fromDate.setDate(fromDate.getDate() - 90);

    // ══════════════════════════════════════════════════════════════════════
    // STEP 1 — Fetch relevant projects
    //
    // User:  owns the project + not archived
    // Admin: not archived + stage is not a terminal (won/lost) stage
    //        → isWonStage = false AND isLostStage = false
    //        This is more robust than hardcoding stage names: works even if
    //        stages are renamed, and covers all active pipeline positions.
    // ══════════════════════════════════════════════════════════════════════
    const projectWhere = isAdmin
      ? `WHERE p."isArchived" = false
           AND ps."isWonStage"  = false
           AND ps."isLostStage" = false
           AND ps."deletedAt"   IS NULL`
      : `WHERE p."isArchived" = false
           AND p."ownerId" = :userId`;

    const projects = await sequelize.query(
      `SELECT
         p.id::text                  AS id,
         p."nomProjet",
         p."statut",
         p."promoteur",
         p."priority",
         p."isArchived",
         p."projectModele"::text     AS "projectModele",
         p."validationStatut"::text  AS "validationStatut",
         p."nextRelanceDate",
         ps.id::text                 AS "stageId",
         ps.name                     AS "stageName",
         ps.color                    AS "stageColor",
         ps.position                 AS "stagePosition",
         u.id::text                  AS "ownerId",
         u.email                     AS "ownerEmail",
         up.name                     AS "ownerName",
         up."avatarUrl"              AS "ownerAvatarUrl"
       FROM   projects p
       JOIN   pipeline_stages ps     ON ps.id       = p."pipelineStageId"
       JOIN   users u                ON u.id         = p."ownerId"
       LEFT JOIN user_profiles up    ON up."userId"  = u.id
       ${projectWhere}
       ORDER BY p."nomProjet" ASC`,
      { replacements: { userId }, type: "SELECT" }
    );

    console.log("PROJECTS =", projects.length);

    if (projects.length === 0) {
      return res.json({
        count: 0, today: [], upcoming: [], overdue: [],
        meta: {
          role, userId, isAdmin,
          daysWindow:  days,
          fromDate:    fromDate.toISOString(),
          toDate:      windowEnd.toISOString(),
          ownerFilter: isAdmin ? null : userId,
          sources:     { projects: 0, reminders: 0, actions: 0 },
        },
      });
    }

    const projectIds = projects.map(p => p.id);

    // ══════════════════════════════════════════════════════════════════════
    // STEP 2 — Fetch reminders in the date window for those projects
    //
    // sequelize.query() with type:"SELECT" returns rows[] directly.
    // Never double-destructure with [[x]] — plain object is not iterable.
    // ══════════════════════════════════════════════════════════════════════
    const reminders = await sequelize.query(
      `SELECT
         pr.id::text                 AS id,
         pr."projectId"::text        AS "projectId",
         pr."dateRelance",
         pr.message,
         pr."actionId"::text         AS "actionId",
         pa."typeAction_legacy"      AS "actionLegacy",
         pa.commentaire              AS "actionCommentaire",
         pa."dateAction",
         pa.statut                   AS "actionStatut",
         pat.id::text                AS "actionTypeId",
         pat.name                    AS "actionTypeName",
         pat.icon                    AS "actionTypeIcon",
         pat.color                   AS "actionTypeColor"
       FROM   project_reminders pr
       LEFT JOIN project_actions pa       ON pa.id  = pr."actionId"
       LEFT JOIN project_action_types pat ON pat.id = pa."actionTypeId"
       WHERE  pr."projectId"::text IN (:projectIds)
         AND  pr."dateRelance" >= :fromDate
         AND  pr."dateRelance" <= :windowEnd
       ORDER BY pr."dateRelance" ASC`,
      { replacements: { projectIds, fromDate, windowEnd }, type: "SELECT" }
    );

    console.log("REMINDERS =", reminders.length);

    // ══════════════════════════════════════════════════════════════════════
    // STEP 3 — Fetch actions with dateRelance not already covered by a reminder
    // ══════════════════════════════════════════════════════════════════════
    const actions = await sequelize.query(
      `SELECT
         pa.id::text                 AS id,
         pa."projectId"::text        AS "projectId",
         pa."dateRelance",
         pa.commentaire              AS message,
         pa."typeAction_legacy"      AS "actionLegacy",
         pa.commentaire              AS "actionCommentaire",
         pa."dateAction",
         pa.statut                   AS "actionStatut",
         pat.id::text                AS "actionTypeId",
         pat.name                    AS "actionTypeName",
         pat.icon                    AS "actionTypeIcon",
         pat.color                   AS "actionTypeColor"
       FROM   project_actions pa
       LEFT JOIN project_action_types pat ON pat.id = pa."actionTypeId"
       WHERE  pa."projectId"::text IN (:projectIds)
         AND  pa."dateRelance" IS NOT NULL
         AND  pa."dateRelance" >= :fromDate
         AND  pa."dateRelance" <= :windowEnd
         AND  NOT EXISTS (
                SELECT 1 FROM project_reminders pr WHERE pr."actionId" = pa.id
              )
       ORDER BY pa."dateRelance" ASC`,
      { replacements: { projectIds, fromDate, windowEnd }, type: "SELECT" }
    );

    console.log("ACTIONS =", actions.length);

    // ══════════════════════════════════════════════════════════════════════
    // STEP 4 — Group reminders and actions by projectId (O(n))
    // ══════════════════════════════════════════════════════════════════════
    const remindersByProject = {};
    for (const r of reminders) {
      if (!remindersByProject[r.projectId]) remindersByProject[r.projectId] = [];
      remindersByProject[r.projectId].push(r);
    }

    const actionsByProject = {};
    for (const a of actions) {
      if (!actionsByProject[a.projectId]) actionsByProject[a.projectId] = [];
      actionsByProject[a.projectId].push(a);
    }

    // ══════════════════════════════════════════════════════════════════════
    // STEP 5 — Build one followup entry per project
    // ══════════════════════════════════════════════════════════════════════
    const followups = [];

    for (const project of projects) {
      const pid     = project.id;
      const projRem = remindersByProject[pid] || [];
      const projAct = actionsByProject[pid]   || [];

      let primaryDate = null;
      let source      = "project";
      let sourceData  = null;

      if (projRem.length > 0) {
        // Priority 1: earliest reminder in window (already sorted ASC)
        sourceData  = projRem[0];
        primaryDate = new Date(sourceData.dateRelance);
        source      = "reminder";
      } else if (projAct.length > 0) {
        // Priority 2: earliest action with dateRelance
        sourceData  = projAct[0];
        primaryDate = new Date(sourceData.dateRelance);
        source      = "action";
      } else if (project.nextRelanceDate) {
        // Priority 3: project-level nextRelanceDate
        primaryDate = new Date(project.nextRelanceDate);
        // User: skip if the date is completely outside our window
        if (!isAdmin && (primaryDate < fromDate || primaryDate > windowEnd)) continue;
      } else if (!isAdmin) {
        // User: no followup data in range → skip this project
        continue;
      }
      // Admin/superadmin: include even with no date at all (null → overdue)

      let isToday   = false;
      let isLate    = false;
      let daysUntil = null;

      if (primaryDate) {
        isToday   = primaryDate >= todayStart && primaryDate <= todayEnd;
        isLate    = primaryDate < todayStart;
        daysUntil = Math.ceil((primaryDate - now) / 86400000);
      } else {
        isLate = true;  // no date scheduled → needs immediate attention
      }

      followups.push({
        id:          sourceData?.id || `project-${pid}`,
        source,
        projectId:   pid,
        actionId:    sourceData?.actionId || null,
        projectUrl:  `/forms/project?id=${pid}`,
        timelineUrl: `/forms/project-timeline?projectId=${pid}`,

        nomProjet:        project.nomProjet,
        statut:           project.statut           || null,
        promoteur:        project.promoteur        || null,
        priority:         project.priority         || null,
        validationStatut: project.validationStatut || null,
        isArchived:       project.isArchived,
        projectModele:    project.projectModele    || null,

        pipelineStage: project.stageId ? {
          id:       project.stageId,
          name:     project.stageName,
          color:    project.stageColor    || null,
          position: project.stagePosition ?? null,
        } : null,

        actionType: sourceData?.actionTypeId
          ? { id: sourceData.actionTypeId, name: sourceData.actionTypeName, icon: sourceData.actionTypeIcon || null, color: sourceData.actionTypeColor || null }
          : sourceData?.actionLegacy
            ? { id: null, name: sourceData.actionLegacy, icon: null, color: null }
            : null,

        message:        sourceData?.message           || null,
        commentaire:    sourceData?.actionCommentaire || null,
        dateRelance:    primaryDate ? primaryDate.toISOString() : null,
        dateAction:     sourceData?.dateAction        || null,
        actionStatut:   sourceData?.actionStatut      || null,

        remindersCount: projRem.length,
        actionsCount:   projAct.length,

        daysUntil,
        isToday,
        isLate,

        owner: project.ownerEmail ? {
          id:        project.ownerId,
          email:     project.ownerEmail,
          name:      project.ownerName || project.ownerEmail,
          avatarUrl: project.ownerAvatarUrl || null,
        } : null,
      });
    }

    // Sort ASC by date; null dates sink to the bottom of overdue
    followups.sort((a, b) => {
      if (!a.dateRelance && !b.dateRelance) return 0;
      if (!a.dateRelance) return 1;
      if (!b.dateRelance) return -1;
      return new Date(a.dateRelance) - new Date(b.dateRelance);
    });

    const todayList = followups.filter(f =>  f.isToday);
    const upcoming  = followups.filter(f => !f.isToday && !f.isLate);
    const overdue   = followups.filter(f =>  f.isLate);
    const count     = followups.length;   // one entry per project

    console.log(
      `RELANCES_FOUND = ${count} | today=${todayList.length} upcoming=${upcoming.length} overdue=${overdue.length}`
    );

    return res.json({
      count,
      today:    todayList,
      upcoming,
      overdue,
      meta: {
        role,
        userId,
        isAdmin,
        daysWindow:  days,
        fromDate:    fromDate.toISOString(),
        toDate:      windowEnd.toISOString(),
        ownerFilter: isAdmin ? null : userId,
        sources: {
          projects:  projects.length,
          reminders: reminders.length,
          actions:   actions.length,
        },
      },
    });

  } catch (err) {
    console.error("UPCOMING_FOLLOWUPS_ERROR:", err);
    return res.status(500).json({ message: err.message || "Server error" });
  }
});

module.exports = router;
