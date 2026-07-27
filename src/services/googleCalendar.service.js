"use strict";

// Intégration Google Calendar — OAuth2 (authorization code + refresh token)
// et création/mise à jour/suppression d'événements dans le calendrier
// "primary" du commercial connecté.
//
// Best-effort partout : aucune fonction d'écriture (create/update/delete
// event) ne lève — chaque échec (pas de compte connecté, token invalide,
// erreur réseau/API) retourne { success:false, ... } et ne doit jamais
// faire échouer le Follow-up appelant (voir followupAutomation.service.js).
//
// Logging : chaque tentative de création/mise à jour d'événement affiche un
// bloc "GOOGLE CALENDAR" complet (commercial, calendrier ciblé, statut des
// tokens, id d'événement créé) — c'est la seule source fiable pour
// diagnostiquer un rendez-vous manquant côté Google (voir audit).

const axios = require("axios");
const dayjs = require("dayjs");
const GoogleCalendarAccount = require("../models/GoogleCalendarAccount");
const tokenCrypto = require("../utils/tokenCrypto");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// "primary" = calendrier principal du compte Google authentifié par
// l'access token utilisé — donc toujours celui du commercial connecté
// (userId), jamais un calendrier partagé/fixe.
const GOOGLE_CALENDAR_ID = "primary";
const GOOGLE_CALENDAR_EVENTS_URL = `https://www.googleapis.com/calendar/v3/calendars/${GOOGLE_CALENDAR_ID}/events`;
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];
const DEFAULT_TIMEZONE = "Africa/Tunis";

// Marge de sécurité avant expiration réelle — évite d'utiliser un access
// token qui expire pendant l'appel API.
const EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// ── 1) URL de consentement ────────────────────────────────────────────────

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: mustEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: mustEnv("GOOGLE_REDIRECT_URI"),
    response_type: "code",
    access_type: "offline",
    prompt: "consent", // garantit un refresh_token à chaque connexion
    scope: SCOPES.join(" "),
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ── 2) Échange code -> tokens ──────────────────────────────────────────────

async function exchangeCodeForTokens(code) {
  const { data } = await axios.post(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      code,
      client_id: mustEnv("GOOGLE_CLIENT_ID"),
      client_secret: mustEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: mustEnv("GOOGLE_REDIRECT_URI"),
      grant_type: "authorization_code",
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  // { access_token, refresh_token, expires_in, scope, token_type, id_token }
  return data;
}

async function fetchGoogleEmail(accessToken) {
  try {
    const { data } = await axios.get(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data?.email || null;
  } catch (err) {
    console.error("[GoogleCalendar] fetchGoogleEmail error:", err.message);
    return null;
  }
}

// ── 3) Enregistrement des tokens (connexion initiale) ──────────────────────

async function saveTokensForUser(userId, tokens) {
  const googleEmail = tokens.access_token ? await fetchGoogleEmail(tokens.access_token) : null;

  const values = {
    userId,
    googleEmail,
    accessTokenEnc: tokenCrypto.encrypt(tokens.access_token),
    accessTokenExpiresAt: dayjs().add(tokens.expires_in || 3600, "second").toDate(),
    scope: tokens.scope || SCOPES.join(" "),
  };

  // Google ne renvoie un refresh_token que lors du tout premier consentement
  // (ou avec prompt=consent, à chaque fois) — ne jamais écraser un refresh
  // token existant par une valeur absente.
  if (tokens.refresh_token) {
    values.refreshTokenEnc = tokenCrypto.encrypt(tokens.refresh_token);
  }

  const [account] = await GoogleCalendarAccount.findOrCreate({
    where: { userId },
    defaults: values,
  });
  await account.update(values);

  console.log(
    `✅ [GoogleCalendar] Compte connecté — userId=${userId} email=${googleEmail || "?"} ` +
      `refreshTokenSaved=${Boolean(values.refreshTokenEnc)}`
  );

  return account;
}

// ── 4) Access token valide (refresh automatique) ────────────────────────────
//
// Retourne null UNIQUEMENT si aucun compte Google n'est connecté pour cet
// utilisateur (ou pas de refresh token enregistré) — c'est le cas
// "not_connected", best-effort, jamais une erreur. Si un compte existe mais
// que le renouvellement du token échoue (token révoqué côté Google, etc.),
// cette fonction LÈVE l'erreur d'origine — c'est un vrai échec, à
// distinguer d'un simple "pas connecté" (voir createCalendarEvent).
async function getValidAccessToken(userId) {
  const account = await GoogleCalendarAccount.findOne({ where: { userId } });

  if (!account || !account.refreshTokenEnc) {
    console.log("Refresh token : KO (aucun compte Google connecté pour ce commercial)");
    return null;
  }
  console.log(`Refresh token : OK (compte connecté — ${account.googleEmail || userId})`);

  const expiresAt = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt).getTime() : 0;
  if (account.accessTokenEnc && expiresAt - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
    console.log("Access token  : OK (en cache, encore valide)");
    return tokenCrypto.decrypt(account.accessTokenEnc);
  }

  // Access token expiré (ou absent) — renouvellement via le refresh token.
  const refreshToken = tokenCrypto.decrypt(account.refreshTokenEnc);
  const { data } = await axios.post(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: mustEnv("GOOGLE_CLIENT_ID"),
      client_secret: mustEnv("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  await account.update({
    accessTokenEnc: tokenCrypto.encrypt(data.access_token),
    accessTokenExpiresAt: dayjs().add(data.expires_in || 3600, "second").toDate(),
  });

  console.log("Access token  : OK (renouvelé via refresh token)");
  return data.access_token;
}

async function isConnected(userId) {
  const account = await GoogleCalendarAccount.findOne({ where: { userId } });
  return Boolean(account?.refreshTokenEnc);
}

async function getStatus(userId) {
  const account = await GoogleCalendarAccount.findOne({ where: { userId } });
  return { connected: Boolean(account?.refreshTokenEnc), googleEmail: account?.googleEmail || null };
}

async function disconnect(userId) {
  await GoogleCalendarAccount.destroy({ where: { userId } });
}

// ── 5) Événements calendrier ────────────────────────────────────────────────

function buildEventPayload({ summary, description, location, startDateTime, endDateTime, timeZone, reminderMinutes }) {
  const payload = {
    summary,
    description,
    location: location || undefined,
    start: { dateTime: dayjs(startDateTime).toISOString(), timeZone: timeZone || DEFAULT_TIMEZONE },
    end: { dateTime: dayjs(endDateTime).toISOString(), timeZone: timeZone || DEFAULT_TIMEZONE },
  };
  // Rappels natifs Google (notification popup côté Google Calendar) —
  // optionnel : omis, le calendrier applique ses rappels par défaut (comportement inchangé).
  if (Array.isArray(reminderMinutes) && reminderMinutes.length) {
    payload.reminders = {
      useDefault: false,
      overrides: reminderMinutes.map((minutes) => ({ method: "popup", minutes })),
    };
  }
  return payload;
}

function logErrorBlock({ action, commercialLabel, err }) {
  console.error(`\n================ GOOGLE CALENDAR ERROR (${action}) =================`);
  console.error("Commercial     :", commercialLabel);
  console.error("HTTP Status    :", err.response?.status ?? "N/A (pas de réponse HTTP — erreur réseau/config)");
  console.error("Google message :", err.response?.data?.error?.message || err.response?.data || err.message);
  console.error("Stack          :", err.stack);
  console.error("======================================================================\n");
}

async function createCalendarEvent({
  userId,
  summary,
  description,
  location,
  startDateTime,
  endDateTime,
  timeZone,
  commercialLabel,
  reminderMinutes,
}) {
  const label = commercialLabel || userId;
  console.log("\n================ GOOGLE CALENDAR =================");
  console.log("Commercial :", label);
  console.log("Calendar   :", GOOGLE_CALENDAR_ID);

  try {
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      console.log("Creating event... SKIPPED (aucun compte Google connecté)");
      console.log("==================================================\n");
      return { success: false, skipped: true, reason: "not_connected" };
    }

    console.log("Creating event...");
    const { status, data } = await axios.post(
      GOOGLE_CALENDAR_EVENTS_URL,
      buildEventPayload({ summary, description, location, startDateTime, endDateTime, timeZone, reminderMinutes }),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    console.log("[Google API Response] CRM Action Created → Google Event Created — HTTP", status);
    console.log("[Google Event ID]", data.id);
    console.log("Event created :", data.id);
    console.log("googleEventId :", data.id);
    console.log("eventLink     :", data.htmlLink);
    console.log("==================================================\n");

    return {
      success: true,
      eventId: data.id,
      eventLink: data.htmlLink || null,
      calendarId: GOOGLE_CALENDAR_ID,
      httpStatus: status,
    };
  } catch (err) {
    console.log("==================================================");
    logErrorBlock({ action: "createCalendarEvent", commercialLabel: label, err });
    const message = err.response?.data?.error?.message || err.message;
    return { success: false, error: message };
  }
}

async function updateCalendarEvent({
  userId,
  eventId,
  summary,
  description,
  location,
  startDateTime,
  endDateTime,
  timeZone,
  commercialLabel,
  reminderMinutes,
}) {
  const label = commercialLabel || userId;
  console.log("\n================ GOOGLE CALENDAR =================");
  console.log("Commercial :", label);
  console.log("Calendar   :", GOOGLE_CALENDAR_ID);
  console.log("Event      :", eventId, "(mise à jour)");

  try {
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      console.log("Updating event... SKIPPED (aucun compte Google connecté)");
      console.log("==================================================\n");
      return { success: false, skipped: true, reason: "not_connected" };
    }

    console.log("Updating event...");
    const { status, data } = await axios.patch(
      `${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(eventId)}`,
      buildEventPayload({ summary, description, location, startDateTime, endDateTime, timeZone, reminderMinutes }),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    console.log("[Google API Response] CRM Action Updated → Google Event Updated — HTTP", status);
    console.log("[Google Event ID]", data.id);
    console.log("Event updated :", data.id);
    console.log("googleEventId :", data.id);
    console.log("eventLink     :", data.htmlLink);
    console.log("==================================================\n");

    return {
      success: true,
      eventId: data.id,
      eventLink: data.htmlLink || null,
      calendarId: GOOGLE_CALENDAR_ID,
      httpStatus: status,
    };
  } catch (err) {
    // Événement déjà supprimé côté Google — on retombe sur une création.
    if (err.response?.status === 404 || err.response?.status === 410) {
      console.log("Event introuvable côté Google (404/410) — recréation...");
      console.log("==================================================\n");
      return createCalendarEvent({
        userId,
        summary,
        description,
        location,
        startDateTime,
        endDateTime,
        timeZone,
        commercialLabel,
        reminderMinutes,
      });
    }
    console.log("==================================================");
    logErrorBlock({ action: "updateCalendarEvent", commercialLabel: label, err });
    const message = err.response?.data?.error?.message || err.message;
    return { success: false, error: message };
  }
}

async function deleteCalendarEvent({ userId, eventId, commercialLabel }) {
  const label = commercialLabel || userId;
  try {
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) return { success: false, skipped: true, reason: "not_connected" };

    const { status } = await axios.delete(`${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log(`[Google API Response] Google Event Deleted — HTTP ${status}`);
    console.log(`[Google Event ID] ${eventId}`);
    console.log(`✅ [GoogleCalendar] Event supprimé — eventId=${eventId} commercial=${label}`);
    return { success: true };
  } catch (err) {
    // Déjà supprimé/inexistant côté Google — considéré comme un succès.
    if (err.response?.status === 404 || err.response?.status === 410) {
      return { success: true };
    }
    logErrorBlock({ action: "deleteCalendarEvent", commercialLabel: label, err });
    const message = err.response?.data?.error?.message || err.message;
    return { success: false, error: message };
  }
}

module.exports = {
  SCOPES,
  getAuthUrl,
  exchangeCodeForTokens,
  saveTokensForUser,
  getValidAccessToken,
  isConnected,
  getStatus,
  disconnect,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
};
