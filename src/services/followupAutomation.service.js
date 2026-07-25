"use strict";

// Orchestrateur de l'automatisation Follow-up : calendrier, notifications
// CRM, email, WhatsApp. Déclenché uniquement pour info@probardistribution.com
// (voir commercial_contacts.routes.js) quand un Follow-up a date + heure.
//
// Le calendrier + les notifications sont créés dans UNE transaction
// Sequelize (données critiques). Email/WhatsApp/push temps réel sont des
// effets de bord best-effort exécutés APRÈS le commit : un échec d'un de
// ces canaux externes ne doit jamais annuler le Follow-up déjà enregistré
// ni faire échouer la requête HTTP.

const { sequelize } = require("../db");
const Notification = require("../models/Notification");
const UserProfile = require("../models/UserProfile");
const CommercialProject = require("../models/CommercialProject");
const CalendarEventSync = require("../models/CalendarEventSync");
const Task = require("../models/Task");
const {
  buildFollowupTaskContent,
  combineDateTime,
  taskStatusFromRelance,
} = require("./calendar.service");
const { sendWhatsappMessage, isConfigured: isWhatsappConfigured } = require("./whatsapp.service");
const { emitToUser } = require("../socket");
const {
  resolveRecipients,
  syncEventForRecipients,
  syncTaskForRecipients,
  deleteEventForRecipients,
  sendEmailToRecipients,
} = require("./multiRecipientCalendarSync.service");

const APP_BASE_URL = process.env.APP_WEB_URL || "https://www.crmprobar.com";

function clientName(contact) {
  return `${contact.nom || ""} ${contact.prenom || ""}`.trim() || "Client";
}

async function resolveProjectName(contact) {
  try {
    const project = await CommercialProject.findOne({
      where: { commercialContactId: contact.id },
      order: [["createdAt", "ASC"]],
    });
    return project?.nomProjet || null;
  } catch (err) {
    console.error("[FollowupAutomation] resolveProjectName error:", err.message);
    return null;
  }
}

function buildFollowupEmailHtml({ contact, relance, projectName }) {
  const name = clientName(contact);
  return `<!DOCTYPE html>
<html lang="fr">
<body style="font-family: Arial, sans-serif; color:#1E293B;">
  <h2 style="color:#4F46E5;">Nouveau Follow-up planifié</h2>
  <table cellpadding="6" style="border-collapse:collapse;">
    <tr><td><b>Client</b></td><td>${name}</td></tr>
    <tr><td><b>Projet</b></td><td>${projectName || "-"}</td></tr>
    <tr><td><b>Date</b></td><td>${relance.dateRelance || "-"}</td></tr>
    <tr><td><b>Heure</b></td><td>${relance.heureRelance || "-"}</td></tr>
    <tr><td><b>Commentaire</b></td><td>${relance.commentaire || "-"}</td></tr>
    <tr><td><b>Commercial concerné</b></td><td>${relance.commercialName || "-"}</td></tr>
  </table>
  <p><a href="${APP_BASE_URL}" style="color:#4F46E5;">Ouvrir le CRM</a></p>
</body>
</html>`;
}

function buildFollowupWhatsappMessage({ contact, relance, projectName }) {
  return [
    "Bonjour,",
    "",
    "Nouveau Follow-up planifié.",
    "",
    `Client : ${clientName(contact)}`,
    `Date : ${relance.dateRelance || "-"}`,
    `Heure : ${relance.heureRelance || "-"}`,
    `Projet : ${projectName || "-"}`,
    `Commentaire : ${relance.commentaire || "-"}`,
    "",
    "Merci.",
  ].join("\n");
}

function aggregateFlags(results) {
  if (!results.length) return { synced: false, error: null };
  const allSynced = results.every((r) => r.success);
  const firstError = results.find((r) => !r.success && !r.skipped)?.error || null;
  return { synced: allSynced, error: allSynced ? null : firstError };
}

// Best-effort : crée/reporte l'événement dans le Google Calendar de CHAQUE
// destinataire — toujours info@probardistribution.com + le commercial de la
// relance (relance.commercialId), dédupliqués si identiques (voir
// multiRecipientCalendarSync.service.js). Ne lève jamais — persiste les
// flags agrégés googleEventId/googleCalendarSynced/googleCalendarError sur
// la relance (compat) ; le détail par destinataire vit dans CalendarEventSync.
async function syncGoogleCalendarEvent({ contact, relance, projectName }) {
  const recipients = await resolveRecipients({ selectedUserId: relance.commercialId });
  if (!recipients.length) {
    console.log(`[FollowupAutomation] SKIP relance=${relance.id} : aucun destinataire résolu.`);
    return { attempted: false };
  }

  console.log("Projet     :", projectName || "-");
  console.log("Commercial :", relance.commercialName || relance.commercialEmail || "-");

  const start = combineDateTime(relance.dateRelance, relance.heureRelance);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const { title, description } = buildFollowupTaskContent({ contact, relance, projectName });

  const results = await syncEventForRecipients({
    entityType: "commercial_contact_relance",
    entityId: relance.id,
    recipients,
    summary: title,
    description,
    location: contact.localisation || undefined,
    start,
    end,
  });

  const { synced, error } = aggregateFlags(results);
  await relance.update({
    googleEventId: results.find((r) => r.userId === relance.commercialId)?.eventId || results[0]?.eventId || null,
    googleCalendarSynced: synced,
    googleCalendarError: error,
  });

  return { attempted: true, success: synced, results };
}

// Follow-up marqué "faite"/"annulee" : pas de re-notification (email/
// WhatsApp/notification CRM n'ont de sens que pour un Follow-up planifié),
// seulement une synchro best-effort du calendrier interne + Google (tous
// destinataires).
async function syncStatusOnlyChange({ relance }) {
  const summary = { calendarSynced: false, googleCalendarSynced: false };

  // Met à jour le Task de CHAQUE destinataire (pas seulement l'ancien champ
  // agrégé relance.calendarEventId, qui ne reflète qu'un seul destinataire).
  try {
    const syncs = await CalendarEventSync.findAll({
      where: { entityType: "commercial_contact_relance", entityId: relance.id },
    });
    const newStatus = taskStatusFromRelance(relance);
    let anyUpdated = false;
    for (const sync of syncs) {
      if (!sync.taskId) continue;
      const task = await Task.findByPk(sync.taskId);
      if (task) {
        await task.update({ status: newStatus });
        anyUpdated = true;
      }
    }
    summary.calendarSynced = anyUpdated;
  } catch (err) {
    console.error(`❌ [FollowupAutomation] Échec sync Task (statut) — relance=${relance.id}:`, err.message);
  }

  if (relance.statutRelance === "annulee") {
    try {
      const results = await deleteEventForRecipients({
        entityType: "commercial_contact_relance",
        entityId: relance.id,
      });
      await relance.update({ googleEventId: null, googleCalendarSynced: false, googleCalendarError: null });
      summary.googleCalendarSynced = results.every((r) => r.success);
    } catch (err) {
      console.error(`❌ [FollowupAutomation] Échec suppression Google Calendar — relance=${relance.id}:`, err.message);
    }
  }

  return summary;
}

async function runFollowupAutomation({ relance, contact, actorUser }) {
  if (relance.statutRelance && relance.statutRelance !== "planifiee") {
    return syncStatusOnlyChange({ relance });
  }

  const summary = {
    calendarEventCreated: false,
    notificationsSent: false,
    emailsSent: false,
    whatsappSent: false,
    whatsappConfigured: isWhatsappConfigured(),
    googleCalendarCreated: false,
  };

  const projectName = await resolveProjectName(contact);
  const name = clientName(contact);

  // Destinataires — TOUJOURS info@probardistribution.com + le commercial
  // affecté (relance.commercialId), dédupliqués par email. C'est la MÊME
  // liste pour la notification, le calendrier CRM, Google Calendar et
  // l'email — "le traitement doit être identique pour tous les utilisateurs".
  const recipients = await resolveRecipients({ selectedUserId: relance.commercialId });
  if (!recipients.length) {
    console.warn(`[FollowupAutomation] Aucun destinataire résolu pour relance=${relance.id}`);
  }

  // ── 1) Notifications — transaction critique, une par destinataire ────
  // BUG CORRIGÉ : cette boucle existait déjà, mais le calendrier CRM (Task,
  // voir étape 1bis) ne créait auparavant qu'UNE SEULE ligne pour
  // actorUser.id (toujours info@...) — le commercial affecté au projet ne
  // voyait jamais la relance dans son propre Calendrier Follow-up.
  const notifiedUserIds = new Set();
  try {
    await sequelize.transaction(async (t) => {
      for (const recipient of recipients) {
        await Notification.create(
          {
            userId: recipient.userId,
            type: "FOLLOWUP_PLANNED",
            title: "Nouveau Follow-up planifié",
            message: `${name} — ${relance.dateRelance} ${relance.heureRelance || ""}`.trim(),
            commercialContactId: contact.id,
            relanceId: relance.id,
            isRead: false,
          },
          { transaction: t }
        );
        notifiedUserIds.add(recipient.userId);
      }
      await relance.update({ notificationSent: notifiedUserIds.size > 0 }, { transaction: t });
    });
    summary.notificationsSent = notifiedUserIds.size > 0;
    console.log(`✅ [FollowupAutomation] Notifications créées — relance=${relance.id} (${notifiedUserIds.size} destinataire(s))`);
  } catch (err) {
    console.error(`❌ [FollowupAutomation] Échec notifications — relance=${relance.id}:`, err.message);
    // Données critiques non écrites → on n'envoie ni email ni WhatsApp pour
    // un événement qui n'a en réalité pas été créé.
    return summary;
  }

  // ── 1bis) Calendrier CRM — un Task par destinataire (best-effort) ─────
  const start = combineDateTime(relance.dateRelance, relance.heureRelance);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const { title, description } = buildFollowupTaskContent({ contact, relance, projectName });

  let taskResults = [];
  try {
    taskResults = await syncTaskForRecipients({
      entityType: "commercial_contact_relance",
      entityId: relance.id,
      recipients,
      title,
      description,
      start,
      end,
      status: taskStatusFromRelance(relance),
    });
    // Champ agrégé (compat) : reflète le Task du commercial s'il existe,
    // sinon le premier destinataire — le détail par destinataire vit dans
    // CalendarEventSync.
    const commercialTask = taskResults.find((r) => r.userId === relance.commercialId);
    await relance.update({ calendarEventId: commercialTask?.taskId || taskResults[0]?.taskId || null });
    summary.calendarEventCreated = taskResults.length > 0;
  } catch (err) {
    console.error(`❌ [FollowupAutomation] Échec calendrier CRM — relance=${relance.id}:`, err.message);
  }

  // ── 2) Push temps réel (best-effort) ──────────────────────────────────
  try {
    const payload = {
      relanceId: relance.id,
      commercialContactId: contact.id,
      title: "Nouveau Follow-up planifié",
    };
    for (const recipient of recipients) {
      emitToUser(recipient.userId, "followup-planned", payload);
    }
  } catch (err) {
    console.error("❌ [FollowupAutomation] emitToUser error:", err.message);
  }

  // ── 3) Email (best-effort) — mêmes destinataires que le calendrier Google
  // (info@probardistribution.com + commercial, dédupliqués). Ne doit jamais
  // échouer à cause du SMTP : sendEmail() ne lève jamais, et toute erreur
  // est conservée sur la relance (emailError) plutôt que perdue en console. ──
  let sentTo = [];
  try {
    sentTo = await sendEmailToRecipients({
      recipients,
      subjectLabel: "Nouveau Follow-up planifié",
      buildHtml: () => buildFollowupEmailHtml({ contact, relance, projectName }),
      buildText: () => `Nouveau Follow-up planifié pour ${clientName(contact)}.`,
    });

    if (sentTo.length) {
      await relance.update({ emailSent: true, emailError: null });
      summary.emailsSent = true;
    } else if (recipients.length) {
      await relance.update({ emailError: "Échec inconnu" });
    }
  } catch (err) {
    console.error(`❌ [FollowupAutomation] Échec envoi email — relance=${relance.id}:`, err.message);
    try {
      await relance.update({ emailError: err.message });
    } catch (_) {}
  }

  // ── 4) WhatsApp (best-effort) — même contrat : jamais bloquant, erreur
  // conservée (whatsappError) si Twilio est configuré mais échoue. ──────
  try {
    const message = buildFollowupWhatsappMessage({ contact, relance, projectName });
    const profiles = await UserProfile.findAll({
      where: { userId: recipients.map((r) => r.userId) },
    });
    const numbers = [...new Set(profiles.map((p) => p.phone).filter(Boolean))];

    let anyWhatsappSuccess = false;
    let lastError = null;
    for (const phone of numbers) {
      const result = await sendWhatsappMessage(phone, message);
      if (result.success) anyWhatsappSuccess = true;
      else if (!result.skipped) lastError = result.error;
    }

    await relance.update({
      whatsappSent: anyWhatsappSuccess,
      whatsappError: anyWhatsappSuccess ? null : lastError,
    });
    summary.whatsappSent = anyWhatsappSuccess;
  } catch (err) {
    console.error(`❌ [FollowupAutomation] Échec WhatsApp — relance=${relance.id}:`, err.message);
    try {
      await relance.update({ whatsappError: err.message });
    } catch (_) {}
  }

  // ── 5) Google Calendar (best-effort) — un événement par destinataire ──
  const googleResult = await syncGoogleCalendarEvent({ contact, relance, projectName });
  summary.googleCalendarCreated = Boolean(googleResult.success);

  // ── Logs groupés par destinataire (point demandé) ─────────────────────
  for (const recipient of recipients) {
    const hasTask = taskResults.some((r) => r.userId === recipient.userId);
    const googleRes = googleResult.results?.find((r) => r.userId === recipient.userId);
    console.log(`\nDestinataire : ${recipient.email}`);
    console.log(notifiedUserIds.has(recipient.userId) ? "Notification créée" : "Notification NON créée");
    console.log(hasTask ? "Calendrier CRM créé" : "Calendrier CRM NON créé");
    console.log(googleRes?.success ? "Google Calendar synchronisé" : "Google Calendar NON synchronisé");
    console.log(sentTo.includes(recipient.email) ? "Email envoyé" : "Email NON envoyé");
  }

  return summary;
}

module.exports = { runFollowupAutomation, clientName, resolveProjectName };
