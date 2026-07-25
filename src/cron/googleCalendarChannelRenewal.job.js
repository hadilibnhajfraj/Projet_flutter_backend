"use strict";

// Renouvelle quotidiennement les canaux push Google Calendar (events.watch)
// avant leur expiration (~30 jours) — sans ce cron, la sync entrante
// Google -> CRM (Phase B) s'arrêterait silencieusement pour tout compte dont
// le canal expire. Voir googleCalendarWatch.service.js::renewExpiringChannels.

const cron = require("node-cron");
const { renewExpiringChannels } = require("../services/googleCalendarWatch.service");

console.log("🔥 GOOGLE CALENDAR CHANNEL RENEWAL CRON LOADED");

const AUTO_EMAIL_JOBS_ENABLED = process.env.AUTO_EMAIL_JOBS_ENABLED === "true";

if (AUTO_EMAIL_JOBS_ENABLED) {
  // Une fois par jour à 3h du matin (heure Tunis) — largement avant le seuil
  // de renouvellement de 48h utilisé par renewExpiringChannels().
  cron.schedule("0 3 * * *", () => {
    renewExpiringChannels().catch((err) =>
      console.error("❌ [googleCalendarChannelRenewal] cron error:", err.message)
    );
  }, { timezone: "Africa/Tunis" });
} else {
  console.log("[googleCalendarChannelRenewal.job] AUTO_EMAIL_JOBS_ENABLED=false — cron NOT scheduled.");
}

module.exports = { renewExpiringChannels };
