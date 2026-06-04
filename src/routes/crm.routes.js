"use strict";

const express = require("express");
const { sequelize } = require("../db");
const { authRequired } = require("../middleware/auth.middleware");

const router = express.Router();

const ADMIN_ROLES = ["admin", "superadmin"];

/**
 * GET /crm/upcoming-followups
 *
 * Aggregates relances from 3 sources:
 *   1. project_reminders.dateRelance
 *   2. project_actions.dateRelance  (only when no project_reminder exists for same action)
 *   3. projects.nextRelanceDate
 *
 * Each item is enriched with: project, pipeline stage, action type, owner.
 *
 * Role-based:
 *   admin/superadmin → all projects
 *   user/commercial  → WHERE p."ownerId" = :userId
 *
 * isArchived is NOT filtered — relances appear regardless of project archive status.
 *
 * Query params:
 *   days=30   look-ahead window in days (default 30, max 365)
 */
router.get("/upcoming-followups", authRequired, async (req, res) => {
  try {
    const userId  = req.user.sub;
    const role    = req.user.role;
    const isAdmin = ADMIN_ROLES.includes(role);

    console.log("USER_ID",  userId);
    console.log("ROLE",     role);
    console.log("IS_ADMIN", isAdmin);

    // ── Time window ────────────────────────────────────────────────────────
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(),  0,  0,  0,   0);
    const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const windowEnd  = new Date(todayStart);
    windowEnd.setDate(windowEnd.getDate() + days);

    // Always look 90 days back to capture overdue reminders
    const fromDate = new Date(todayStart);
    fromDate.setDate(fromDate.getDate() - 90);

    console.log("TIME_WINDOW", fromDate.toISOString(), "→", windowEnd.toISOString());

    // ── Role-based owner clause (table always aliased as "p") ──────────────
    const ownerClauseP = isAdmin ? "" : `AND p."ownerId" = :userId`;
    const replacements = { userId, fromDate, windowEnd };

    // ── Shared SELECT columns for project + pipeline + owner ───────────────
    // Reused across all 3 sources to keep queries DRY in comments.
    // Each source adds its own action/reminder-specific columns.

    // ══════════════════════════════════════════════════════════════════════
    // SOURCE 1 — project_reminders
    //
    // SELECT pr.id, pr."dateRelance", pr.message,
    //        pr."projectId", pr."actionId",
    //        pa.id, pa."typeAction_legacy", pa.commentaire, pa."dateAction", pa."statut",
    //        pat.id, pat.name, pat.icon, pat.color,
    //        p.id, p."nomProjet", p."statut", p."promoteur", p."priority",
    //          p."isArchived", p."projectModele"::text, p."validationStatut"::text,
    //          p."ownerId", p."pipelineStageId",
    //        ps.id, ps.name, ps.color, ps.position,
    //        u.id, u.email,
    //        up.name, up."avatarUrl"
    // FROM project_reminders pr
    // INNER JOIN projects p              ON p.id   = pr."projectId"
    // LEFT  JOIN project_actions pa      ON pa.id  = pr."actionId"
    // LEFT  JOIN project_action_types pat ON pat.id = pa."actionTypeId"
    // LEFT  JOIN pipeline_stages ps      ON ps.id  = p."pipelineStageId"
    // LEFT  JOIN users u                 ON u.id   = p."ownerId"
    // LEFT  JOIN user_profiles up        ON up."userId" = u.id
    // WHERE pr."dateRelance" BETWEEN :fromDate AND :windowEnd
    //   [AND p."ownerId" = :userId]
    // ORDER BY pr."dateRelance" ASC
    // ══════════════════════════════════════════════════════════════════════
    const reminderRows = await sequelize.query(
      `SELECT
         pr.id::text                  AS "sourceId",
         'reminder'                   AS source,
         pr."dateRelance",
         pr.message,
         pr."projectId",
         pr."actionId",
         -- action fields
         pa."typeAction_legacy"       AS "actionLegacy",
         pa.commentaire               AS "actionCommentaire",
         pa."dateAction",
         pa.statut                    AS "actionStatut",
         -- action type
         pat.id::text                 AS "actionTypeId",
         pat.name                     AS "actionTypeName",
         pat.icon                     AS "actionTypeIcon",
         pat.color                    AS "actionTypeColor",
         -- project fields
         p."nomProjet",
         p."statut",
         p."promoteur",
         p."priority",
         p."isArchived",
         p."projectModele"::text      AS "projectModele",
         p."validationStatut"::text   AS "validationStatut",
         p."ownerId",
         -- pipeline stage
         ps.id::text                  AS "stageId",
         ps.name                      AS "stageName",
         ps.color                     AS "stageColor",
         ps.position                  AS "stagePosition",
         -- owner
         u.id::text                   AS "ownerId",
         u.email                      AS "ownerEmail",
         up.name                      AS "ownerName",
         up."avatarUrl"               AS "ownerAvatarUrl"
       FROM   project_reminders pr
       INNER JOIN projects p               ON p.id   = pr."projectId"
       LEFT  JOIN project_actions pa       ON pa.id  = pr."actionId"
       LEFT  JOIN project_action_types pat ON pat.id = pa."actionTypeId"
       LEFT  JOIN pipeline_stages ps       ON ps.id  = p."pipelineStageId"
       LEFT  JOIN users u                  ON u.id   = p."ownerId"
       LEFT  JOIN user_profiles up         ON up."userId" = u.id
       WHERE  pr."dateRelance" >= :fromDate
         AND  pr."dateRelance" <= :windowEnd
         ${ownerClauseP}
       ORDER BY pr."dateRelance" ASC`,
      { replacements, type: "SELECT" }
    );

    console.log("REMINDERS_FOUND", reminderRows.length);

    // ══════════════════════════════════════════════════════════════════════
    // SOURCE 2 — project_actions.dateRelance
    // (excluded when a project_reminder already covers the same action)
    //
    // SELECT pa.id, pa."dateRelance", pa.commentaire, pa."dateAction", pa."statut",
    //        pa."projectId",
    //        pa."typeAction_legacy",
    //        pat.id, pat.name, pat.icon, pat.color,
    //        p ... ps ... u ... up  (same as source 1)
    // FROM project_actions pa
    // INNER JOIN projects p              ON p.id  = pa."projectId"
    // LEFT  JOIN project_action_types pat ON pat.id = pa."actionTypeId"
    // LEFT  JOIN pipeline_stages ps       ON ps.id  = p."pipelineStageId"
    // LEFT  JOIN users u                  ON u.id   = p."ownerId"
    // LEFT  JOIN user_profiles up         ON up."userId" = u.id
    // WHERE pa."dateRelance" IS NOT NULL
    //   AND pa."dateRelance" BETWEEN :fromDate AND :windowEnd
    //   AND NOT EXISTS (SELECT 1 FROM project_reminders pr WHERE pr."actionId" = pa.id)
    //   [AND p."ownerId" = :userId]
    // ORDER BY pa."dateRelance" ASC
    // ══════════════════════════════════════════════════════════════════════
    const actionRows = await sequelize.query(
      `SELECT
         pa.id::text                  AS "sourceId",
         'action'                     AS source,
         pa."dateRelance",
         pa.commentaire               AS message,
         pa."projectId",
         pa.id                        AS "actionId",
         -- action fields
         pa."typeAction_legacy"       AS "actionLegacy",
         pa.commentaire               AS "actionCommentaire",
         pa."dateAction",
         pa.statut                    AS "actionStatut",
         -- action type
         pat.id::text                 AS "actionTypeId",
         pat.name                     AS "actionTypeName",
         pat.icon                     AS "actionTypeIcon",
         pat.color                    AS "actionTypeColor",
         -- project fields
         p."nomProjet",
         p."statut",
         p."promoteur",
         p."priority",
         p."isArchived",
         p."projectModele"::text      AS "projectModele",
         p."validationStatut"::text   AS "validationStatut",
         p."ownerId",
         -- pipeline stage
         ps.id::text                  AS "stageId",
         ps.name                      AS "stageName",
         ps.color                     AS "stageColor",
         ps.position                  AS "stagePosition",
         -- owner
         u.id::text                   AS "ownerId",
         u.email                      AS "ownerEmail",
         up.name                      AS "ownerName",
         up."avatarUrl"               AS "ownerAvatarUrl"
       FROM   project_actions pa
       INNER JOIN projects p               ON p.id  = pa."projectId"
       LEFT  JOIN project_action_types pat ON pat.id = pa."actionTypeId"
       LEFT  JOIN pipeline_stages ps       ON ps.id  = p."pipelineStageId"
       LEFT  JOIN users u                  ON u.id   = p."ownerId"
       LEFT  JOIN user_profiles up         ON up."userId" = u.id
       WHERE  pa."dateRelance" IS NOT NULL
         AND  pa."dateRelance" >= :fromDate
         AND  pa."dateRelance" <= :windowEnd
         AND  NOT EXISTS (
                SELECT 1 FROM project_reminders pr
                WHERE  pr."actionId" = pa.id
              )
         ${ownerClauseP}
       ORDER BY pa."dateRelance" ASC`,
      { replacements, type: "SELECT" }
    );

    console.log("ACTIONS_FOUND", actionRows.length);

    // ══════════════════════════════════════════════════════════════════════
    // SOURCE 3 — projects.nextRelanceDate
    //
    // SELECT p.id, p."nextRelanceDate" AS "dateRelance",
    //        p ... ps ... u ... up  (same project/stage/owner block)
    //        NULLs for action-specific columns
    // FROM projects p
    // LEFT JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
    // LEFT JOIN users u            ON u.id  = p."ownerId"
    // LEFT JOIN user_profiles up   ON up."userId" = u.id
    // WHERE p."nextRelanceDate" IS NOT NULL
    //   AND p."nextRelanceDate" BETWEEN :fromDate AND :windowEnd
    //   [AND p."ownerId" = :userId]
    // ORDER BY p."nextRelanceDate" ASC
    // ══════════════════════════════════════════════════════════════════════
    const projectRows = await sequelize.query(
      `SELECT
         ('project-' || p.id)::text   AS "sourceId",
         'project'                    AS source,
         p."nextRelanceDate"          AS "dateRelance",
         NULL::text                   AS message,
         p.id                         AS "projectId",
         NULL::uuid                   AS "actionId",
         -- action fields (null for project-level relances)
         NULL::text                   AS "actionLegacy",
         NULL::text                   AS "actionCommentaire",
         NULL::timestamptz            AS "dateAction",
         NULL::text                   AS "actionStatut",
         -- action type (null)
         NULL::text                   AS "actionTypeId",
         NULL::text                   AS "actionTypeName",
         NULL::text                   AS "actionTypeIcon",
         NULL::text                   AS "actionTypeColor",
         -- project fields
         p."nomProjet",
         p."statut",
         p."promoteur",
         p."priority",
         p."isArchived",
         p."projectModele"::text      AS "projectModele",
         p."validationStatut"::text   AS "validationStatut",
         p."ownerId",
         -- pipeline stage
         ps.id::text                  AS "stageId",
         ps.name                      AS "stageName",
         ps.color                     AS "stageColor",
         ps.position                  AS "stagePosition",
         -- owner
         u.id::text                   AS "ownerId",
         u.email                      AS "ownerEmail",
         up.name                      AS "ownerName",
         up."avatarUrl"               AS "ownerAvatarUrl"
       FROM   projects p
       LEFT   JOIN pipeline_stages ps  ON ps.id        = p."pipelineStageId"
       LEFT   JOIN users u             ON u.id          = p."ownerId"
       LEFT   JOIN user_profiles up    ON up."userId"   = u.id
       WHERE  p."nextRelanceDate" IS NOT NULL
         AND  p."nextRelanceDate" >= :fromDate
         AND  p."nextRelanceDate" <= :windowEnd
         ${ownerClauseP}
       ORDER BY p."nextRelanceDate" ASC`,
      { replacements, type: "SELECT" }
    );

    console.log("PROJECTS_FOUND", projectRows.length);
    console.log("TOTAL_SOURCES", reminderRows.length + actionRows.length + projectRows.length);

    // ── Normalize all sources into a single unified shape ──────────────────
    const normalize = (r) => {
      const date     = new Date(r.dateRelance);
      const isToday  = date >= todayStart && date <= todayEnd;
      const isLate   = date < todayStart;
      const daysUntil = Math.ceil((date - now) / 86400000);

      return {
        // ── identifiers ─────────────────────────────────────────
        id:        r.sourceId,
        source:    r.source,       // "reminder" | "action" | "project"
        projectId: r.projectId,
        actionId:  r.actionId || null,
        projectUrl:   `/forms/project?id=${r.projectId}`,
        timelineUrl:  `/forms/project-timeline?projectId=${r.projectId}`,

        // ── project info ─────────────────────────────────────────
        nomProjet:        r.nomProjet,
        statut:           r.statut,
        promoteur:        r.promoteur    || null,
        priority:         r.priority     || null,
        validationStatut: r.validationStatut,
        isArchived:       r.isArchived,
        projectModele:    r.projectModele,

        // ── pipeline stage ────────────────────────────────────────
        pipelineStage: r.stageId
          ? {
              id:       r.stageId,
              name:     r.stageName,
              color:    r.stageColor    || null,
              position: r.stagePosition ?? null,
            }
          : null,

        // ── action type ───────────────────────────────────────────
        actionType: r.actionTypeId
          ? {
              id:    r.actionTypeId,
              name:  r.actionTypeName,
              icon:  r.actionTypeIcon  || null,
              color: r.actionTypeColor || null,
            }
          : (r.actionLegacy
              ? { id: null, name: r.actionLegacy, icon: null, color: null }
              : null),

        // ── relance / action dates ────────────────────────────────
        message:     r.message           || null,
        commentaire: r.actionCommentaire || null,
        dateRelance: r.dateRelance,
        dateAction:  r.dateAction        || null,
        actionStatut: r.actionStatut     || null,

        // ── timing helpers ────────────────────────────────────────
        daysUntil,
        isToday,
        isLate,

        // ── owner ─────────────────────────────────────────────────
        owner: r.ownerEmail
          ? {
              id:        r.ownerId,
              email:     r.ownerEmail,
              name:      r.ownerName || r.ownerEmail,
              avatarUrl: r.ownerAvatarUrl || null,
            }
          : null,
      };
    };

    // ── Merge + sort by dateRelance ASC ───────────────────────────────────
    const all = [
      ...reminderRows.map(normalize),
      ...actionRows.map(normalize),
      ...projectRows.map(normalize),
    ].sort((a, b) => new Date(a.dateRelance) - new Date(b.dateRelance));

    const todayList  = all.filter((r) =>  r.isToday);
    const upcoming   = all.filter((r) => !r.isToday && !r.isLate);
    const overdue    = all.filter((r) =>  r.isLate);
    const count      = all.length;

    console.log(
      `RELANCES_FOUND ${count}`,
      `| today=${todayList.length}`,
      `| upcoming=${upcoming.length}`,
      `| overdue=${overdue.length}`
    );

    return res.json({
      count,
      today:    todayList,
      upcoming,
      overdue,
      meta: {
        role:       isAdmin ? "admin" : "user",
        userId,
        daysWindow: days,
        fromDate:   fromDate.toISOString(),
        toDate:     windowEnd.toISOString(),
        sources: {
          reminders: reminderRows.length,
          actions:   actionRows.length,
          projects:  projectRows.length,
        },
      },
    });

  } catch (err) {
    console.error("UPCOMING_FOLLOWUPS_ERROR:", err);
    return res.status(500).json({ message: err.message || "Server error" });
  }
});

module.exports = router;
