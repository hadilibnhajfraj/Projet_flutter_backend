/**
 * test-followup-multi-recipient.js
 *
 * Regression smoke test: every recipient of a commercial follow-up
 * (info@probardistribution.com + the commercial assigned to the project)
 * must get IDENTICAL treatment — Notification, personal CRM calendar Task,
 * Google Calendar event, and email. Before this fix, only the creator
 * (always info@probardistribution.com) got a Task in their own calendar;
 * the assigned commercial got nothing in "their" Calendrier Follow-up.
 *
 * Drives the real HTTP API of an already-running dev server, asserts on
 * the DB (Notification, Task via CalendarEventSync.taskId, CalendarEventSync
 * itself), and cleans up the relance it creates.
 *
 * Usage: node src/scripts/test-followup-multi-recipient.js
 */

require("dotenv").config();
require("../models/associations");
const axios = require("axios");
const dayjs = require("dayjs");
const { sequelize } = require("../db");
const User = require("../models/User");
const CommercialContact = require("../models/CommercialContact");
const CommercialContactRelance = require("../models/CommercialContactRelance");
const Notification = require("../models/Notification");
const Task = require("../models/Task");
const CalendarEventSync = require("../models/CalendarEventSync");
const { signAccessToken } = require("../utils/tokens");

const API_BASE_URL = process.env.TEST_API_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
const INFO_EMAIL = "info@probardistribution.com";
const COMMERCIAL_EMAIL = process.env.TEST_COMMERCIAL_EMAIL || "hadil.ibnhajfraj@gmail.com";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

async function run() {
  console.log("\n🧪  Follow-up multi-recipient — smoke test\n");

  const info = await User.findOne({ where: { email: INFO_EMAIL } });
  const commercial = await User.findOne({ where: { email: COMMERCIAL_EMAIL } });
  assert(Boolean(info), `${INFO_EMAIL} exists as a User`);
  assert(Boolean(commercial), `${COMMERCIAL_EMAIL} exists as a User`);

  const contact = await CommercialContact.findOne({
    where: { createdBy: info.id, statut: "ok" },
    order: [["createdAt", "DESC"]],
  });
  assert(Boolean(contact), "Found an existing 'ok' contact created by info@ to attach the test relance to");
  if (!contact) { await sequelize.close(); process.exit(1); }

  const token = signAccessToken({ sub: info.id, email: info.email, role: info.role });
  const http = axios.create({ baseURL: API_BASE_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });

  let relanceId;
  try {
    const dateRelance = dayjs().add(1, "day").format("YYYY-MM-DD");
    const res = await http.post(`/commercial-contacts/${contact.id}/relances`, {
      dateRelance,
      heureRelance: "10:00",
      commentaire: "Test automatisé — multi-destinataires",
      commercialId: commercial.id,
    });
    assert(res.status === 201, `Create relance → HTTP ${res.status}`);
    relanceId = res.data?.id;
    assert(Boolean(relanceId), "Relance id returned");

    await new Promise((r) => setTimeout(r, 1500));

    const relance = await CommercialContactRelance.findByPk(relanceId);
    assert(relance?.commercialId === commercial.id, "relance.commercialId correctly set to the assigned commercial");

    const notifs = await Notification.findAll({ where: { relanceId } });
    const notifiedIds = notifs.map((n) => n.userId);
    assert(notifiedIds.includes(info.id), `Notification created for ${INFO_EMAIL}`);
    assert(notifiedIds.includes(commercial.id), `Notification created for ${COMMERCIAL_EMAIL}`);

    const syncs = await CalendarEventSync.findAll({
      where: { entityType: "commercial_contact_relance", entityId: relanceId },
    });
    assert(syncs.length === 2, `2 CalendarEventSync rows (info + commercial) — found ${syncs.length}`);

    const infoSync = syncs.find((s) => s.userId === info.id);
    const commercialSync = syncs.find((s) => s.userId === commercial.id);
    assert(Boolean(infoSync?.taskId), `Task created for ${INFO_EMAIL} (their own Calendrier Follow-up)`);
    assert(Boolean(commercialSync?.taskId), `Task created for ${COMMERCIAL_EMAIL} (their own Calendrier Follow-up) — THE BUG BEING FIXED`);

    if (infoSync?.taskId) {
      const infoTask = await Task.findByPk(infoSync.taskId);
      assert(infoTask?.createdBy === info.id, `Task.createdBy === info's userId (so GET /tasks shows it for info@)`);
    }
    if (commercialSync?.taskId) {
      const commercialTask = await Task.findByPk(commercialSync.taskId);
      assert(commercialTask?.createdBy === commercial.id, `Task.createdBy === commercial's userId (so GET /tasks shows it for them too)`);
    }

    console.log(`  ℹ️  info@ synced=${infoSync?.synced} error=${infoSync?.error}`);
    console.log(`  ℹ️  commercial synced=${commercialSync?.synced} error=${commercialSync?.error}`);
  } finally {
    if (relanceId) {
      const relance = await CommercialContactRelance.findByPk(relanceId);
      const syncs = relance ? await CalendarEventSync.findAll({
        where: { entityType: "commercial_contact_relance", entityId: relanceId },
      }) : [];
      for (const s of syncs) {
        if (s.taskId) await Task.destroy({ where: { id: s.taskId } });
      }
      await CalendarEventSync.destroy({ where: { entityType: "commercial_contact_relance", entityId: relanceId } });
      await Notification.destroy({ where: { relanceId } });
      await CommercialContactRelance.destroy({ where: { id: relanceId } });
    }
    await sequelize.close();
  }

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("\n❌  Test script crashed:", err.response?.data || err.message);
  console.error(err);
  process.exit(1);
});
