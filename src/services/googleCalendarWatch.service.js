"use strict";

// Canal push Google Calendar (`events.watch`) — permet à Google de notifier
// notre backend quand un événement change directement dans Google Calendar
// (sync entrante, voir googleCalendarInboundSync.service.js).
//
// Best-effort et conditionnel : Google exige une URL HTTPS PUBLIQUE pour le
// receveur webhook — impossible à enregistrer depuis un backend local
// (localhost). Sans GOOGLE_CALENDAR_WEBHOOK_BASE_URL configurée en https,
// registerWatchChannel() ne fait rien (log explicite) — le reste du système
// (sync CRM -> Google) continue de fonctionner normalement.

const crypto = require("crypto");
const axios = require("axios");
const dayjs = require("dayjs");
const GoogleCalendarAccount = require("../models/GoogleCalendarAccount");
const googleCalendarService = require("./googleCalendar.service");

const GOOGLE_CALENDAR_ID = "primary";
const WATCH_URL = `https://www.googleapis.com/calendar/v3/calendars/${GOOGLE_CALENDAR_ID}/events/watch`;
const STOP_URL = "https://www.googleapis.com/calendar/v3/channels/stop";
// Google plafonne la durée de vie d'un canal "events" ; on demande le max
// documenté (~30 jours) mais on renouvelle bien avant (cron quotidien,
// seuil 48h — voir googleCalendarChannelRenewal.job.js).
const TTL_SECONDS = 30 * 24 * 60 * 60;

function webhookBaseUrl() {
  const url = process.env.GOOGLE_CALENDAR_WEBHOOK_BASE_URL;
  if (!url) return null;
  if (!url.startsWith("https://")) {
    console.warn(
      `[GoogleCalendarWatch] GOOGLE_CALENDAR_WEBHOOK_BASE_URL="${url}" n'est pas en https — Google refusera l'enregistrement du canal. Canal NON enregistré.`
    );
    return null;
  }
  return url.replace(/\/+$/, "");
}

async function registerWatchChannel(userId) {
  const base = webhookBaseUrl();
  if (!base) {
    console.log(`[GoogleCalendarWatch] SKIP registerWatchChannel(${userId}) — pas d'URL webhook publique configurée.`);
    return { attempted: false, reason: "no_public_webhook_url" };
  }

  try {
    const accessToken = await googleCalendarService.getValidAccessToken(userId);
    if (!accessToken) {
      console.log(`[GoogleCalendarWatch] SKIP registerWatchChannel(${userId}) — compte Google non connecté.`);
      return { attempted: false, reason: "not_connected" };
    }

    const channelId = crypto.randomUUID();
    const watchToken = crypto.randomBytes(24).toString("hex");

    const { data } = await axios.post(
      WATCH_URL,
      {
        id: channelId,
        type: "web_hook",
        address: `${base}/google-calendar/webhook`,
        token: watchToken,
        params: { ttl: String(TTL_SECONDS) },
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    await GoogleCalendarAccount.update(
      {
        watchChannelId: data.id,
        watchResourceId: data.resourceId,
        watchExpiration: data.expiration ? new Date(Number(data.expiration)) : dayjs().add(TTL_SECONDS, "second").toDate(),
        watchToken,
      },
      { where: { userId } }
    );

    console.log(`✅ [GoogleCalendarWatch] Canal enregistré — userId=${userId} channelId=${data.id}`);
    return { attempted: true, success: true };
  } catch (err) {
    console.error(`❌ [GoogleCalendarWatch] Échec registerWatchChannel(${userId}):`, err.response?.data || err.message);
    return { attempted: true, success: false, error: err.message };
  }
}

async function stopWatchChannel(userId) {
  try {
    const account = await GoogleCalendarAccount.findOne({ where: { userId } });
    if (!account?.watchChannelId) return { attempted: false };

    const accessToken = await googleCalendarService.getValidAccessToken(userId);
    if (accessToken) {
      try {
        await axios.post(
          STOP_URL,
          { id: account.watchChannelId, resourceId: account.watchResourceId },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
      } catch (err) {
        // Canal déjà expiré/invalide côté Google — pas bloquant, on nettoie quand même.
        console.warn(`[GoogleCalendarWatch] stop channel (best-effort) — ${err.message}`);
      }
    }

    await account.update({
      watchChannelId: null,
      watchResourceId: null,
      watchExpiration: null,
      watchToken: null,
      nextSyncToken: null,
    });
    return { attempted: true, success: true };
  } catch (err) {
    console.error(`❌ [GoogleCalendarWatch] Échec stopWatchChannel(${userId}):`, err.message);
    return { attempted: true, success: false };
  }
}

// Renouvelle tous les canaux dont l'expiration approche (< 48h) — cible du
// cron googleCalendarChannelRenewal.job.js.
async function renewExpiringChannels() {
  const threshold = dayjs().add(48, "hour").toDate();
  const accounts = await GoogleCalendarAccount.findAll({
    where: {},
  });

  let renewed = 0;
  let skipped = 0;
  for (const account of accounts) {
    const needsRenewal =
      account.refreshTokenEnc &&
      (!account.watchExpiration || new Date(account.watchExpiration) < threshold);
    if (!needsRenewal) continue;

    const result = await registerWatchChannel(account.userId);
    if (result.success) renewed += 1;
    else skipped += 1;
  }

  console.log(`[GoogleCalendarWatch] renewExpiringChannels — renewed=${renewed} skipped=${skipped}`);
  return { renewed, skipped };
}

module.exports = { registerWatchChannel, stopWatchChannel, renewExpiringChannels };
