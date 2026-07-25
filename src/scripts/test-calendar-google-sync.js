/**
 * test-calendar-google-sync.js
 *
 * Regression smoke test for the Timeline-action -> CRM Calendar -> Google
 * Calendar integration (see docs/calendar-google-sync.md). Same convention
 * as test-product-family-diameter.js: no Jest/Mocha in this repo, so this
 * drives the REAL HTTP API of an already-running dev server with a signed
 * JWT, then asserts directly on the DB rows (Task, ProjectActivity,
 * ProjectAction). Creates its own project/action and cleans up after itself.
 *
 * Prerequisites:
 *   - The Backend Master dev server must already be running.
 *   - A user row for TEST_USER_EMAIL must exist, unrestricted by
 *     moduleAccessGuard.js, with NO Google Calendar account connected (this
 *     test asserts the "not connected" skip path — googleCalendarSynced=false,
 *     googleCalendarError=null).
 *
 * Usage:
 *   node src/scripts/test-calendar-google-sync.js
 */

require("dotenv").config();
const axios = require("axios");
const dayjs = require("dayjs");
const { sequelize } = require("../db");
const User = require("../models/User");
const Project = require("../models/Project");
const ProjectAction = require("../models/ProjectAction");
const Task = require("../models/Task");
const ProjectActivity = require("../models/ProjectActivity");
const { signAccessToken } = require("../utils/tokens");

const API_BASE_URL = process.env.TEST_API_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL || "manegerofficecbi@gmail.com";
const NAME_PREFIX = "Test CalendarSync Automated";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

async function run() {
  console.log("\n🧪  Timeline action -> CRM Calendar -> Google Calendar — smoke test\n");

  const user = await User.findOne({ where: { email: TEST_USER_EMAIL } });
  if (!user) {
    throw new Error(`TEST_USER_EMAIL '${TEST_USER_EMAIL}' not found — seed it first.`);
  }

  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const http = axios.create({
    baseURL: API_BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  let projectId;
  let actionId;
  let taskId;

  try {
    // ── 1. Create a project (auto-owned by the creator, POST /) ──────────
    const projectRes = await http.post("/projects", {
      nomProjet: `${NAME_PREFIX} ${Date.now()}`,
      dateDemarrage: "2026-07-21",
      typeAdresseChantier: "Chantier",
      firstAction: "Visite",
      dateVisite: "2026-07-21",
      latitude: 36.8,
      longitude: 10.2,
      projectModele: "project",
    });
    assert(projectRes.status === 201 || projectRes.status === 200, `Create project → HTTP ${projectRes.status}`);
    projectId = (projectRes.data?.project || projectRes.data)?.id;
    assert(Boolean(projectId), "Create project → id returned");

    const project = await Project.findByPk(projectId);
    assert(project?.ownerId === user.id, "Project auto-owned by its creator (ownerId)");

    // ── 2. Create an action with a future dateRelance/dateFin/priorite ───
    const dateRelance = dayjs().add(2, "day").hour(10).minute(0).second(0).toISOString();
    const dateFin = dayjs(dateRelance).add(1, "hour").toISOString();

    const actionRes = await http.post(`/projects/${projectId}/actions`, {
      typeAction: "Visite",
      commentaire: "Test automatisé — calendrier",
      dateRelance,
      dateFin,
      priorite: "haute",
    });
    assert(actionRes.status === 201, `Create action → HTTP ${actionRes.status}`);
    actionId = actionRes.data?.data?.id;
    assert(Boolean(actionId), "Create action → id returned");

    // Give the best-effort post-commit calendar sync a brief moment to run
    // (it executes synchronously in the request handler today, but this
    // guards against any future async refactor).
    await new Promise((r) => setTimeout(r, 300));

    const action = await ProjectAction.findByPk(actionId);
    assert(Boolean(action?.calendarEventId), "Action → calendarEventId populated (Task created)");
    assert(action?.googleCalendarSynced === false, "Action → googleCalendarSynced=false (owner not connected)");
    assert(action?.googleCalendarError === null, "Action → googleCalendarError=null (clean skip, not an error)");
    taskId = action?.calendarEventId;

    const task = taskId ? await Task.findByPk(taskId) : null;
    assert(Boolean(task), "Task row exists in the CRM calendar (tasks table)");
    assert(task?.createdBy === user.id, "Task.createdBy === project.ownerId (correct agent's calendar)");
    assert(task?.title?.includes("Visite"), "Task.title includes the action type");
    assert(task?.priority === "haute", "Task.priority mirrors the action's priorite");
    assert(Boolean(task?.endAt), "Task.endAt populated (real end time, not the old +30min default)");

    const createdActivity = await ProjectActivity.findOne({
      where: { projectId, type: "calendar_event_created" },
      order: [["createdAt", "DESC"]],
    });
    assert(Boolean(createdActivity), "ProjectActivity 'calendar_event_created' logged (Historique)");

    // ── 3. Update the action's date/time — same Task id, no duplicate ────
    const newDateRelance = dayjs().add(3, "day").hour(14).minute(30).second(0).toISOString();
    const updateRes = await http.put(`/projects/${projectId}/actions/${actionId}`, {
      dateRelance: newDateRelance,
    });
    assert(updateRes.status === 200, `Update action date → HTTP ${updateRes.status}`);

    await new Promise((r) => setTimeout(r, 300));

    const updatedAction = await ProjectAction.findByPk(actionId);
    assert(updatedAction?.calendarEventId === taskId, "Update → same calendarEventId (no duplicate Task)");

    const updatedTask = await Task.findByPk(taskId);
    assert(
      dayjs(updatedTask?.startAt).isSame(dayjs(newDateRelance)),
      "Update → Task.startAt reflects the new dateRelance"
    );

    const updatedActivity = await ProjectActivity.findOne({
      where: { projectId, type: "calendar_event_updated" },
      order: [["createdAt", "DESC"]],
    });
    assert(Boolean(updatedActivity), "ProjectActivity 'calendar_event_updated' logged");

    // ── 3.5. Reassign the project owner — event should follow (point 9) ──
    const newOwner = await User.findOne({
      where: { email: process.env.TEST_SECOND_USER_EMAIL || "wethek@gmail.com" },
    });
    if (newOwner && newOwner.id !== user.id) {
      const ownerRes = await http.put(`/projects/${projectId}/owner`, { ownerId: newOwner.id });
      assert(ownerRes.status === 200, `Reassign project owner → HTTP ${ownerRes.status}`);

      await new Promise((r) => setTimeout(r, 300));

      const taskAfterReassign = await Task.findByPk(taskId);
      assert(taskAfterReassign?.createdBy === newOwner.id, "Task.createdBy follows the new project owner");

      const reassignActivity = await ProjectActivity.findOne({
        where: { projectId, type: "calendar_event_updated" },
        order: [["createdAt", "DESC"]],
      });
      assert(
        reassignActivity?.message?.includes("nouveau responsable"),
        "ProjectActivity logs the owner-change calendar migration"
      );
    } else {
      console.log("  ⏭  Owner reassignment test skipped (TEST_SECOND_USER_EMAIL not found or same as primary)");
    }

    // ── 4. Delete the action — Task removed, no orphan ────────────────────
    const deleteRes = await http.delete(`/projects/${projectId}/actions/${actionId}`);
    assert(deleteRes.status === 200, `Delete action → HTTP ${deleteRes.status}`);

    await new Promise((r) => setTimeout(r, 300));

    const taskAfterDelete = await Task.findByPk(taskId);
    assert(!taskAfterDelete, "Task deleted — no orphan left in the CRM calendar");

    const deletedActivity = await ProjectActivity.findOne({
      where: { projectId, type: "calendar_event_deleted" },
      order: [["createdAt", "DESC"]],
    });
    assert(Boolean(deletedActivity), "ProjectActivity 'calendar_event_deleted' logged");
  } finally {
    // ── Cleanup — direct model access (the API's project DELETE is
    // restricted to "main superadmin", same pre-existing restriction noted
    // in test-product-family-diameter.js). ────────────────────────────────
    if (taskId) await Task.destroy({ where: { id: taskId } });
    if (actionId) await ProjectAction.destroy({ where: { id: actionId } });
    if (projectId) {
      await ProjectActivity.destroy({ where: { projectId } });
      await Project.destroy({ where: { id: projectId } });
    }
    await sequelize.close();
  }

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("\n❌  Test script crashed:", err.message || err);
  console.error(err);
  process.exit(1);
});
