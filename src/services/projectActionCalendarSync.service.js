"use strict";

// Orchestrateur calendrier CRM + Google Calendar pour les actions Timeline.
// Généralise runFollowupAutomation() (followupAutomation.service.js) à
// ProjectAction : le Task (calendrier CRM) + la Notification + l'historique
// (ProjectActivity) sont écrits dans UNE transaction Sequelize (données
// critiques) ; le push Google Calendar (MULTI-DESTINATAIRES, voir
// multiRecipientCalendarSync.service.js) et le temps réel Socket.IO sont des
// effets de bord best-effort APRÈS le commit — un échec de ces canaux
// externes ne doit jamais faire échouer la création/modification/suppression
// de l'action déjà enregistrée.
//
// Destinataires calendrier + email = toujours info@probardistribution.com +
// project.ownerId (le responsable du projet), dédupliqués si identiques —
// voir resolveRecipients() dans multiRecipientCalendarSync.service.js.

const { sequelize } = require("../db");
const Notification = require("../models/Notification");
const User = require("../models/User");
const UserProfile = require("../models/UserProfile");
const ProjectAction = require("../models/ProjectAction");
const Project = require("../models/Project");
const { logActivity } = require("../modules/project-activities/services/projectActivity.service");
const {
  syncCalendarTask,
  deleteCalendarTask,
  actionLabel,
  resolveActionWindow,
} = require("./projectActionCalendar.service");
const { syncGoogleCalendarEvent, deleteGoogleCalendarEvent, removeOwnerRecipient } = require("./projectActionGoogleSync.service");
const { resolveRecipients, sendEmailToRecipients } = require("./multiRecipientCalendarSync.service");
const { emitToUser } = require("../socket");

const APP_WEB_URL = process.env.APP_WEB_URL || "https://www.crmprobar.com";

function buildActionEmailHtml({ action, project, subjectLabel }) {
  const { start, end } = resolveActionWindow(action);
  const link = `${APP_WEB_URL}/forms/project-timeline?projectId=${project.id}`;
  return `<!DOCTYPE html>
<html lang="fr">
<body style="font-family: Arial, sans-serif; color:#1E293B;">
  <h2 style="color:#4F46E5;">${subjectLabel}</h2>
  <table cellpadding="6" style="border-collapse:collapse;">
    <tr><td><b>Projet</b></td><td>${project.nomProjet || "-"}</td></tr>
    <tr><td><b>Client</b></td><td>${project.entreprise || "-"}</td></tr>
    <tr><td><b>Titre</b></td><td>${actionLabel(action)}</td></tr>
    <tr><td><b>Date</b></td><td>${new Date(start).toLocaleDateString("fr-FR")}</td></tr>
    <tr><td><b>Heure</b></td><td>${new Date(start).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} - ${new Date(end).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</td></tr>
    <tr><td><b>Description</b></td><td>${action.commentaire || "-"}</td></tr>
  </table>
  <p><a href="${link}" style="color:#4F46E5;">Ouvrir le projet dans le CRM</a></p>
</body>
</html>`;
}

// Point 4/5 : email envoyé à TOUS les destinataires (info + commercial,
// dédupliqués) — même liste que le calendrier Google.
async function sendActionEmailToRecipients({ action, project, recipients, subjectLabel }) {
  return sendEmailToRecipients({
    recipients,
    subjectLabel,
    buildHtml: () => buildActionEmailHtml({ action, project, subjectLabel }),
    buildText: () => `${subjectLabel} : ${actionLabel(action)} - ${project.nomProjet || ""}`.trim(),
  });
}

async function resolveOwnerInfo(ownerId) {
  if (!ownerId) return { ownerName: null, ownerEmail: null };
  const [user, profile] = await Promise.all([
    User.findByPk(ownerId, { attributes: ["id", "email"] }),
    UserProfile.findOne({ where: { userId: ownerId }, attributes: ["name"] }),
  ]);
  return {
    ownerName: profile?.name || user?.email || null,
    ownerEmail: user?.email || null,
  };
}

async function onActionCreated(action, project, actorUserId) {
  console.log(`[CRM Action Created] action=${action.id} project=${project.id} type=${actionLabel(action)}`);
  const summary = { calendarEventCreated: false, googleCalendarCreated: false, notificationsSent: false, emailSent: false };
  const { ownerName } = await resolveOwnerInfo(project.ownerId);

  // ── 1) Calendrier CRM + notification + historique — transaction critique ──
  try {
    await sequelize.transaction(async (t) => {
      const task = await syncCalendarTask(
        { action, project, ownerId: project.ownerId, ownerName },
        t
      );
      await action.update({ calendarEventId: task.id }, { transaction: t });

      await logActivity(
        {
          projectId: project.id,
          userId: actorUserId,
          type: "calendar_event_created",
          message: `Événement calendrier créé : ${actionLabel(action)}`,
          metadata: { actionId: action.id, taskId: task.id, ownerId: project.ownerId },
        },
        t
      );

      if (project.ownerId) {
        await Notification.create(
          {
            userId: project.ownerId,
            type: "ACTION_CALENDAR_CREATED",
            title: "Nouvel événement dans votre calendrier",
            message: `${actionLabel(action)} - ${project.nomProjet || ""}`.trim(),
            projectId: project.id,
            actionId: action.id,
            isRead: false,
          },
          { transaction: t }
        );
      }
    });
    summary.calendarEventCreated = true;
    summary.notificationsSent = Boolean(project.ownerId);
  } catch (err) {
    console.error(`❌ [ProjectActionCalendarSync] Échec calendrier CRM — action=${action.id}:`, err.message);
    // Données critiques non écrites → inutile de tenter Google ensuite.
    return summary;
  }

  // ── 2) Temps réel (best-effort) ──────────────────────────────────────────
  try {
    if (project.ownerId) {
      emitToUser(project.ownerId, "action-calendar-created", { actionId: action.id, projectId: project.id });
    }
  } catch (err) {
    console.error("❌ [ProjectActionCalendarSync] emitToUser error:", err.message);
  }

  // ── 3) Google Calendar — MULTI-DESTINATAIRES (best-effort) ──────────────
  const googleResult = await syncGoogleCalendarEvent({ action, project, ownerName });
  summary.googleCalendarCreated = Boolean(googleResult.success);

  try {
    await logActivity({
      projectId: project.id,
      userId: actorUserId,
      type: googleResult.success ? "google_calendar_synced" : "google_calendar_error",
      message: googleResult.success
        ? "Événement synchronisé avec Google Calendar (tous destinataires)"
        : `Synchronisation Google Calendar partielle ou en échec : ${action.googleCalendarError || "voir logs"}`,
      metadata: { actionId: action.id },
    });
  } catch (err) {
    console.error("❌ [ProjectActionCalendarSync] logActivity (google) error:", err.message);
  }

  // ── 4) Email à tous les destinataires (info + commercial, dédupliqués) ──
  const recipients = await resolveRecipients({ selectedUserId: project.ownerId });
  const sentTo = await sendActionEmailToRecipients({
    action, project, recipients, subjectLabel: "Nouvelle action CRM",
  });
  summary.emailSent = sentTo.length > 0;

  return summary;
}

async function onActionUpdated(action, project, actorUserId) {
  const summary = { calendarEventUpdated: false, googleCalendarUpdated: false };
  const { ownerName } = await resolveOwnerInfo(project.ownerId);

  try {
    await sequelize.transaction(async (t) => {
      const task = await syncCalendarTask(
        { action, project, ownerId: project.ownerId, ownerName },
        t
      );
      if (!action.calendarEventId) {
        await action.update({ calendarEventId: task.id }, { transaction: t });
      }
      await logActivity(
        {
          projectId: project.id,
          userId: actorUserId,
          type: "calendar_event_updated",
          message: `Événement calendrier mis à jour : ${actionLabel(action)}`,
          metadata: { actionId: action.id, taskId: task.id },
        },
        t
      );
    });
    summary.calendarEventUpdated = true;
  } catch (err) {
    console.error(`❌ [ProjectActionCalendarSync] Échec MAJ calendrier CRM — action=${action.id}:`, err.message);
    return summary;
  }

  const googleResult = await syncGoogleCalendarEvent({ action, project, ownerName });
  summary.googleCalendarUpdated = Boolean(googleResult.success);

  try {
    if (project.ownerId) {
      emitToUser(project.ownerId, "action-calendar-updated", { actionId: action.id, projectId: project.id });
    }
  } catch (err) {
    console.error("❌ [ProjectActionCalendarSync] emitToUser error:", err.message);
  }

  return summary;
}

// `action` doit être le snapshot chargé AVANT suppression (calendarEventId
// encore présent) — voir l'appel dans projectAction.service.js.
async function onActionDeleted(action, project, actorUserId) {
  const summary = { calendarEventDeleted: false, googleCalendarDeleted: false };

  const googleResult = await deleteGoogleCalendarEvent({ action });
  summary.googleCalendarDeleted = Boolean(googleResult.success);

  try {
    await deleteCalendarTask(action.calendarEventId);
    summary.calendarEventDeleted = true;

    await logActivity({
      projectId: project.id,
      userId: actorUserId,
      type: "calendar_event_deleted",
      message: `Événement calendrier supprimé : ${actionLabel(action)}`,
      metadata: { actionId: action.id },
    });
  } catch (err) {
    console.error(`❌ [ProjectActionCalendarSync] Échec suppression calendrier — action=${action.id}:`, err.message);
  }

  return summary;
}

// Point 9 : le responsable d'un projet change (PUT /projects/:id/owner) —
// l'ancien propriétaire quitte la liste des destinataires (son événement
// Google est supprimé), info@probardistribution.com reste inchangé, le
// nouveau propriétaire est ajouté. `project` doit déjà porter le NOUVEL
// ownerId. Best-effort par action.
async function onProjectOwnerChanged(project, previousOwnerId, actorUserId) {
  const results = { migrated: 0, failed: 0 };

  if (previousOwnerId === project.ownerId) return results;

  const actions = await ProjectAction.findAll({
    where: { projectId: project.id },
  });

  const { ownerName } = await resolveOwnerInfo(project.ownerId);

  for (const action of actions) {
    try {
      // 1) Retire l'ancien propriétaire de la liste des destinataires (son
      // événement Google est supprimé ; info@... n'est PAS affecté).
      if (previousOwnerId) {
        await removeOwnerRecipient({ action, previousOwnerId });
      }

      // 2) Déplace le Task (calendrier CRM) vers le nouveau propriétaire —
      // même ligne réutilisée (Task.createdBy pilote seul la visibilité
      // dans l'écran Calendar).
      await syncCalendarTask({ action, project, ownerId: project.ownerId, ownerName });

      // 3) Recrée/MAJ l'événement Google pour les destinataires actuels
      // (info + nouveau propriétaire) — best-effort, no-op silencieux si
      // non connecté (voir syncGoogleCalendarEvent).
      await syncGoogleCalendarEvent({ action, project, ownerName });

      await logActivity({
        projectId: project.id,
        userId: actorUserId,
        type: "calendar_event_updated",
        message: `Événement calendrier déplacé vers le nouveau responsable (${ownerName || project.ownerId || "aucun"})`,
        metadata: { actionId: action.id, previousOwnerId, newOwnerId: project.ownerId },
      });

      results.migrated += 1;
    } catch (err) {
      results.failed += 1;
      console.error(`❌ [ProjectActionCalendarSync] Échec migration owner — action=${action.id}:`, err.message);
    }
  }

  return results;
}

// Point 11 : bouton "Réessayer la synchronisation" dans la Timeline —
// relance uniquement la synchro Google (le Task/calendrier CRM existe déjà).
// Ne lève jamais : retourne l'état à jour de l'action pour que l'UI puisse
// rafraîchir le badge immédiatement.
async function retrySync(actionId, actorUserId) {
  const action = await ProjectAction.findByPk(actionId);
  if (!action) throw { status: 404, message: "Action not found" };

  const project = await Project.findByPk(action.projectId);
  if (!project) throw { status: 404, message: "Project not found" };

  const { ownerName } = await resolveOwnerInfo(project.ownerId);
  console.log(`[ProjectActionCalendarSync] retrySync — action=${actionId} (manual retry requested by ${actorUserId})`);

  const googleResult = await syncGoogleCalendarEvent({ action, project, ownerName });

  try {
    await logActivity({
      projectId: project.id,
      userId: actorUserId,
      type: googleResult.success ? "google_calendar_synced" : "google_calendar_error",
      message: googleResult.success
        ? "Synchronisation Google Calendar réessayée avec succès"
        : `Nouvelle tentative de synchronisation Google Calendar échouée : ${action.googleCalendarError || "erreur inconnue"}`,
      metadata: { actionId: action.id },
    });
  } catch (err) {
    console.error("❌ [ProjectActionCalendarSync] logActivity (retry) error:", err.message);
  }

  return ProjectAction.findByPk(actionId);
}

module.exports = {
  onActionCreated,
  onActionUpdated,
  onActionDeleted,
  onProjectOwnerChanged,
  retrySync,
  resolveOwnerInfo,
};
