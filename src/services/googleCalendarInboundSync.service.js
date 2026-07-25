"use strict";

// Sync entrante Google -> CRM (Phase B). Déclenchée par le webhook
// (`POST /google-calendar/webhook`) — Google n'envoie JAMAIS le contenu de
// l'événement dans la notification push, seulement "quelque chose a changé,
// va vérifier" (voir googleCalendarWatch.service.js). Cette fonction liste
// les changements réels via l'API events.list (sync incrémentale par
// syncToken) et les répercute sur les ProjectAction concernées.
//
// Anti-boucle : chaque écriture CRM -> Google enregistre googleUpdatedAt sur
// l'action (voir projectActionGoogleSync.service.js). Si l'`updated` renvoyé
// par Google pour un événement correspond à ce que l'on a déjà enregistré
// (± quelques secondes), c'est notre propre écriture qui nous revient — on
// l'ignore pour ne jamais boucler.
//
// Décision de sécurité (voir le plan) : un événement supprimé côté Google ne
// supprime PAS l'action CRM — seulement le lien (googleEventId), avec une
// notification informant l'agent.

const axios = require("axios");
const dayjs = require("dayjs");
const GoogleCalendarAccount = require("../models/GoogleCalendarAccount");
const ProjectAction = require("../models/ProjectAction");
const Project = require("../models/Project");
const Notification = require("../models/Notification");
const CalendarEventSync = require("../models/CalendarEventSync");
const { logActivity } = require("../modules/project-activities/services/projectActivity.service");
const { syncCalendarTask } = require("./projectActionCalendar.service");
const { resolveOwnerInfo } = require("./projectActionCalendarSync.service");
const googleCalendarService = require("./googleCalendar.service");

const GOOGLE_CALENDAR_ID = "primary";
const EVENTS_URL = `https://www.googleapis.com/calendar/v3/calendars/${GOOGLE_CALENDAR_ID}/events`;
// Tolère un léger écart d'horloge/latence réseau entre notre écriture et
// l'écho que Google nous renvoie ensuite.
const LOOP_GUARD_TOLERANCE_MS = 5000;

async function listChangedEvents(accessToken, syncToken) {
  const params = syncToken ? { syncToken } : { singleEvents: true, timeMin: dayjs().subtract(1, "day").toISOString() };
  const { data } = await axios.get(EVENTS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
  });
  return data;
}

async function applyGoogleEventToAction(action, event, actorUserId) {
  const project = await Project.findByPk(action.projectId);
  if (!project) return;

  if (event.status === "cancelled") {
    // Décision de sécurité : ne jamais supprimer l'action CRM à cause d'un
    // signal externe — seulement désynchroniser + informer.
    await action.update({ googleEventId: null, googleCalendarSynced: false, googleCalendarError: null });
    await logActivity({
      projectId: project.id,
      userId: actorUserId,
      type: "google_calendar_error",
      message: "L'événement a été supprimé directement dans Google Calendar — l'action CRM est conservée mais désynchronisée.",
      metadata: { actionId: action.id },
    });
    if (project.ownerId) {
      await Notification.create({
        userId: project.ownerId,
        type: "ACTION_GOOGLE_DESYNCED",
        title: "Événement Google Calendar supprimé",
        message: `L'événement "${event.summary || ""}" a été supprimé dans Google Calendar. L'action CRM est conservée.`,
        projectId: project.id,
        actionId: action.id,
        isRead: false,
      });
    }
    return;
  }

  const googleUpdated = event.updated ? new Date(event.updated) : null;
  const knownUpdated = action.googleUpdatedAt ? new Date(action.googleUpdatedAt) : null;
  if (googleUpdated && knownUpdated && Math.abs(googleUpdated.getTime() - knownUpdated.getTime()) <= LOOP_GUARD_TOLERANCE_MS) {
    // C'est l'écho de notre propre écriture CRM -> Google — pas un vrai changement.
    return;
  }

  const newStart = event.start?.dateTime ? new Date(event.start.dateTime) : action.dateRelance;
  const newEnd = event.end?.dateTime ? new Date(event.end.dateTime) : action.dateFin;

  await action.update({
    dateRelance: newStart,
    dateFin: newEnd,
    googleUpdatedAt: googleUpdated || new Date(),
  });

  // Répercute sur le Task (calendrier CRM) — même fonction idempotente que
  // pour une écriture CRM classique.
  const { ownerName } = await resolveOwnerInfo(project.ownerId);
  await syncCalendarTask({ action, project, ownerId: project.ownerId, ownerName });

  await logActivity({
    projectId: project.id,
    userId: actorUserId,
    type: "google_calendar_updated_from_google",
    message: "Événement modifié directement dans Google Calendar — répercuté sur l'action CRM.",
    metadata: { actionId: action.id, newStart, newEnd },
  });

  if (project.ownerId) {
    await Notification.create({
      userId: project.ownerId,
      type: "ACTION_UPDATED_FROM_GOOGLE",
      title: "Action mise à jour depuis Google Calendar",
      message: `L'horaire de "${event.summary || ""}" a changé dans Google Calendar.`,
      projectId: project.id,
      actionId: action.id,
      isRead: false,
    });
  }
}

// Point d'entrée appelé par le webhook — best-effort, ne lève jamais (le
// webhook doit répondre 200 quelle que soit l'issue du traitement interne).
async function syncFromGoogle(userId) {
  try {
    const account = await GoogleCalendarAccount.findOne({ where: { userId } });
    if (!account?.refreshTokenEnc) return { attempted: false, reason: "not_connected" };

    const accessToken = await googleCalendarService.getValidAccessToken(userId);
    if (!accessToken) return { attempted: false, reason: "not_connected" };

    let data;
    try {
      data = await listChangedEvents(accessToken, account.nextSyncToken);
    } catch (err) {
      if (err.response?.status === 410) {
        // Jeton de sync invalide/expiré — Google impose un resync complet.
        console.warn(`[GoogleCalendarInboundSync] syncToken expiré (410) — resync complet userId=${userId}`);
        data = await listChangedEvents(accessToken, null);
      } else {
        throw err;
      }
    }

    const events = data.items || [];
    console.log(`[GoogleCalendarInboundSync] userId=${userId} — ${events.length} événement(s) changé(s)`);

    let applied = 0;
    for (const event of events) {
      // Chaque destinataire a son propre googleEventId (sync multi-destinataires,
      // voir multiRecipientCalendarSync.service.js) — on retrouve l'action via
      // CalendarEventSync (googleEventId + userId), pas via l'ancien champ
      // agrégé ProjectAction.googleEventId (qui ne reflète qu'un destinataire).
      const sync = await CalendarEventSync.findOne({
        where: { googleEventId: event.id, userId, entityType: "project_action" },
      });
      if (!sync) continue; // événement Google sans rapport avec le CRM — ignoré
      const action = await ProjectAction.findByPk(sync.entityId);
      if (!action) continue;
      try {
        await applyGoogleEventToAction(action, event, userId);
        applied += 1;
      } catch (err) {
        console.error(`❌ [GoogleCalendarInboundSync] Échec application — action=${action.id}:`, err.message);
      }
    }

    if (data.nextSyncToken) {
      await account.update({ nextSyncToken: data.nextSyncToken });
    }

    return { attempted: true, success: true, applied };
  } catch (err) {
    console.error(`❌ [GoogleCalendarInboundSync] Échec syncFromGoogle(${userId}):`, err.response?.data || err.message);
    return { attempted: true, success: false, error: err.message };
  }
}

module.exports = { syncFromGoogle };
