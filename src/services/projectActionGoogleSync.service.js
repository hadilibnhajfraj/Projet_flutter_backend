"use strict";

// Synchronisation Google Calendar d'une ProjectAction — MULTI-DESTINATAIRES
// (voir multiRecipientCalendarSync.service.js) : toujours
// info@probardistribution.com + le propriétaire du projet (project.ownerId),
// dédupliqués si identiques. Le détail par destinataire vit dans
// CalendarEventSync ; les champs googleEventId/googleCalendarSynced/
// googleCalendarError sur ProjectAction restent des FLAGS AGRÉGÉS (compat
// Flutter — badge Timeline) : synced=true seulement si TOUS les
// destinataires sont synchronisés avec succès.

const { resolveActionWindow, buildActionCalendarContent } = require("./projectActionCalendar.service");
const {
  resolveRecipients,
  syncEventForRecipients,
  removeRecipient,
  deleteEventForRecipients,
} = require("./multiRecipientCalendarSync.service");

// Rappels natifs Google Calendar (point 6 : "Notification Google") — 24h/1h/15min,
// mêmes seuils que le moteur de rappel CRM (followup.job.js).
const GOOGLE_REMINDER_MINUTES = [24 * 60, 60, 15];

function aggregateFlags(results) {
  if (!results.length) return { synced: false, error: null };
  const allSynced = results.every((r) => r.success);
  const firstError = results.find((r) => !r.success && !r.skipped)?.error || null;
  return { synced: allSynced, error: allSynced ? null : firstError };
}

// Crée/MAJ l'événement Google pour CHAQUE destinataire (info + propriétaire
// du projet). Met à jour les flags agrégés sur l'action. Ne lève jamais.
async function syncGoogleCalendarEvent({ action, project, ownerName }) {
  console.log("Projet     :", project.nomProjet || "-");
  console.log("Commercial :", ownerName || project.ownerId || "-");

  const recipients = await resolveRecipients({ selectedUserId: project.ownerId });
  if (!recipients.length) {
    console.log(`[ProjectActionGoogleSync] SKIP action=${action.id} : aucun destinataire résolu.`);
    return { attempted: false, results: [] };
  }

  const { start, end } = resolveActionWindow(action);
  const { title, description } = buildActionCalendarContent({ action, project, ownerName });

  const results = await syncEventForRecipients({
    entityType: "project_action",
    entityId: action.id,
    recipients,
    summary: title,
    description,
    start,
    end,
    reminderMinutes: GOOGLE_REMINDER_MINUTES,
  });

  const { synced, error } = aggregateFlags(results);
  await action.update({
    // Compat : reflète le destinataire "propriétaire du projet" s'il existe,
    // sinon le premier destinataire — l'historique détaillé est dans
    // CalendarEventSync, ce champ n'est plus la source de vérité.
    googleEventId: results.find((r) => r.userId === project.ownerId)?.eventId || results[0]?.eventId || null,
    googleEventLink: results.find((r) => r.userId === project.ownerId)?.eventLink || results[0]?.eventLink || null,
    googleCalendarSynced: synced,
    googleCalendarError: error,
    googleUpdatedAt: new Date(),
  });

  return { attempted: true, success: synced, results };
}

async function deleteGoogleCalendarEvent({ action }) {
  const results = await deleteEventForRecipients({ entityType: "project_action", entityId: action.id });
  return { attempted: true, success: results.every((r) => r.success), results };
}

// Point 9 : réassignation du responsable — l'ancien propriétaire quitte la
// liste des destinataires (son événement Google est supprimé), info@...
// reste inchangé, le nouveau propriétaire est ajouté par le prochain appel
// à syncGoogleCalendarEvent().
async function removeOwnerRecipient({ action, previousOwnerId }) {
  if (!previousOwnerId) return { attempted: false };
  return removeRecipient({ entityType: "project_action", entityId: action.id, userId: previousOwnerId });
}

module.exports = { syncGoogleCalendarEvent, deleteGoogleCalendarEvent, removeOwnerRecipient };
