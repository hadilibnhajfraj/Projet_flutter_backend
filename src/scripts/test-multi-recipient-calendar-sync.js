/**
 * test-multi-recipient-calendar-sync.js
 *
 * Regression smoke test for the multi-recipient Google Calendar sync
 * (see docs/calendar-google-sync.md). Same convention as the other
 * test-*.js scripts in this folder: drives the real HTTP API of an
 * already-running dev server, asserts directly on the DB (CalendarEventSync
 * rows), and — where a recipient has a real connected Google account —
 * verifies the actual event via a direct Google Calendar API GET.
 *
 * Every ProjectAction created here always targets TWO conceptual
 * recipients: info@probardistribution.com (fixed) + the project owner
 * (selected "commercial"), deduplicated by email.
 *
 * Usage: node src/scripts/test-multi-recipient-calendar-sync.js
 */

require("dotenv").config();
require("../models/associations");
const axios = require("axios");
const dayjs = require("dayjs");
const { sequelize } = require("../db");
const User = require("../models/User");
const Project = require("../models/Project");
const ProjectAction = require("../models/ProjectAction");
const Task = require("../models/Task");
const ProjectActivity = require("../models/ProjectActivity");
const CalendarEventSync = require("../models/CalendarEventSync");
const { signAccessToken } = require("../utils/tokens");
const googleCalendarService = require("../services/googleCalendar.service");

const API_BASE_URL = process.env.TEST_API_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
const INFO_EMAIL = "info@probardistribution.com";
const HADIL_EMAIL = "hadil.ibnhajfraj@gmail.com"; // real, Google-connected
const FAYCEL_EMAIL = "faycelmarzouk@probardistribution.com"; // real, likely not connected

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

async function httpFor(user) {
  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  return axios.create({ baseURL: API_BASE_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}

async function createTestProject(http, ownerEmail, label) {
  const res = await http.post("/projects", {
    nomProjet: `MultiRecipient ${label} ${Date.now()}`,
    entreprise: "Test Co",
    dateDemarrage: "2026-07-21", typeAdresseChantier: "Chantier", firstAction: "Visite", dateVisite: "2026-07-21",
    latitude: 36.8, longitude: 10.2, projectModele: "project",
  });
  const projectId = (res.data?.project || res.data)?.id;
  return projectId;
}

async function cleanup(projectId, actionId) {
  if (actionId) {
    const a = await ProjectAction.findByPk(actionId);
    if (a?.calendarEventId) await Task.destroy({ where: { id: a.calendarEventId } });
    await CalendarEventSync.destroy({ where: { entityType: "project_action", entityId: actionId } });
    await ProjectAction.destroy({ where: { id: actionId } });
  }
  if (projectId) {
    await ProjectActivity.destroy({ where: { projectId } });
    await Project.destroy({ where: { id: projectId } });
  }
}

async function run() {
  console.log("\n🧪  Multi-recipient Google Calendar sync — smoke test\n");

  const infoUser = await User.findOne({ where: { email: INFO_EMAIL } });
  const hadil = await User.findOne({ where: { email: HADIL_EMAIL } });
  const faycel = await User.findOne({ where: { email: FAYCEL_EMAIL } });
  assert(Boolean(infoUser), `Fixed recipient ${INFO_EMAIL} exists as a User`);
  assert(Boolean(hadil), `${HADIL_EMAIL} exists as a User`);
  assert(Boolean(faycel), `${FAYCEL_EMAIL} exists as a User`);

  const httpAsHadil = await httpFor(hadil);

  // ── TEST A — owner = Hadil (Google-connected, differs from info) ────────
  console.log("\n— Test A: commercial = Hadil (Google connecté, différent d'info) —");
  let projectId, actionId;
  try {
    projectId = await createTestProject(httpAsHadil, HADIL_EMAIL, "Hadil");
    const dateRelance = dayjs().add(2, "day").hour(10).toISOString();
    const actionRes = await httpAsHadil.post(`/projects/${projectId}/actions`, {
      typeAction: "Réunion", commentaire: "test multi-recipient", dateRelance, priorite: "haute",
    });
    assert(actionRes.status === 201, `Create action (owner=Hadil) → HTTP ${actionRes.status}`);
    actionId = actionRes.data?.data?.id;

    await new Promise((r) => setTimeout(r, 1200));

    const syncs = await CalendarEventSync.findAll({ where: { entityType: "project_action", entityId: actionId } });
    assert(syncs.length === 2, `2 CalendarEventSync rows (info + Hadil) — found ${syncs.length}`);

    const infoSync = syncs.find((s) => s.userId === infoUser.id);
    const hadilSync = syncs.find((s) => s.userId === hadil.id);
    assert(Boolean(infoSync), "Row exists for info@probardistribution.com");
    assert(Boolean(hadilSync), "Row exists for Hadil");
    assert(infoSync?.synced === false && infoSync?.error === null, "info@ → synced=false, error=null (not connected, clean skip)");
    assert(hadilSync?.synced === true && Boolean(hadilSync?.googleEventId), "Hadil → synced=true with a real googleEventId");

    if (hadilSync?.googleEventId) {
      const accessToken = await googleCalendarService.getValidAccessToken(hadil.id);
      const evRes = await axios.get(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${hadilSync.googleEventId}`,
        { headers: { Authorization: `Bearer ${accessToken}` }, validateStatus: () => true }
      );
      assert(evRes.status === 200 && evRes.data?.status === "confirmed", "Hadil's Google event verified live (HTTP 200, confirmed)");
    }

    // ── Update: change date, expect SAME googleEventId (no duplicate) ─────
    const newDate = dayjs().add(3, "day").hour(14).toISOString();
    const updRes = await httpAsHadil.put(`/projects/${projectId}/actions/${actionId}`, { dateRelance: newDate });
    assert(updRes.status === 200, `Update action → HTTP ${updRes.status}`);
    await new Promise((r) => setTimeout(r, 1000));
    const hadilSyncAfterUpdate = await CalendarEventSync.findOne({ where: { entityType: "project_action", entityId: actionId, userId: hadil.id } });
    assert(hadilSyncAfterUpdate?.googleEventId === hadilSync.googleEventId, "Update → same googleEventId for Hadil (no duplicate)");

    // ── Delete: all CalendarEventSync rows + Google events removed ────────
    const delRes = await httpAsHadil.delete(`/projects/${projectId}/actions/${actionId}`);
    assert(delRes.status === 200, `Delete action → HTTP ${delRes.status}`);
    await new Promise((r) => setTimeout(r, 1000));
    const syncsAfterDelete = await CalendarEventSync.findAll({ where: { entityType: "project_action", entityId: actionId } });
    assert(syncsAfterDelete.length === 0, "All CalendarEventSync rows removed after delete — no orphan");
    actionId = null; // already deleted
  } finally {
    await cleanup(projectId, actionId);
  }

  // ── TEST B — owner = info@probardistribution.com itself (dedup) ────────
  console.log("\n— Test B: commercial = info@probardistribution.com (dédoublonnage) —");
  projectId = null; actionId = null;
  try {
    const httpAsInfo = await httpFor(infoUser);
    projectId = await createTestProject(httpAsInfo, INFO_EMAIL, "Info");
    const dateRelance = dayjs().add(2, "day").hour(10).toISOString();
    const actionRes = await httpAsInfo.post(`/projects/${projectId}/actions`, {
      typeAction: "Appel", commentaire: "test dedup", dateRelance,
    });
    assert(actionRes.status === 201, `Create action (owner=info) → HTTP ${actionRes.status}`);
    actionId = actionRes.data?.data?.id;

    await new Promise((r) => setTimeout(r, 1000));
    const syncs = await CalendarEventSync.findAll({ where: { entityType: "project_action", entityId: actionId } });
    assert(syncs.length === 1, `Exactly 1 CalendarEventSync row when commercial === info (dedup) — found ${syncs.length}`);
    assert(syncs[0]?.userId === infoUser.id, "The single row belongs to info@probardistribution.com");
  } finally {
    await cleanup(projectId, actionId);
  }

  // ── TEST C — owner = Faycel (not Google-connected) ──────────────────────
  console.log("\n— Test C: commercial = Faycel —");
  projectId = null; actionId = null;
  try {
    const httpAsFaycel = await httpFor(faycel);
    projectId = await createTestProject(httpAsFaycel, FAYCEL_EMAIL, "Faycel");
    const dateRelance = dayjs().add(2, "day").hour(10).toISOString();
    const actionRes = await httpAsFaycel.post(`/projects/${projectId}/actions`, {
      typeAction: "Echantillonnage", commentaire: "test faycel", dateRelance,
    });
    assert(actionRes.status === 201, `Create action (owner=Faycel) → HTTP ${actionRes.status}`);
    actionId = actionRes.data?.data?.id;

    await new Promise((r) => setTimeout(r, 1000));
    const syncs = await CalendarEventSync.findAll({ where: { entityType: "project_action", entityId: actionId } });
    assert(syncs.length === 2, `2 CalendarEventSync rows (info + Faycel) — found ${syncs.length}`);
    assert(syncs.every((s) => s.error === null), "No hard errors for either recipient (clean skip if not connected)");
  } finally {
    await cleanup(projectId, actionId);
  }

  await sequelize.close();
  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("\n❌  Test script crashed:", err.response?.data || err.message);
  console.error(err);
  process.exit(1);
});
