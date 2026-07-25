"use strict";

// Synchronisation Google Calendar MULTI-DESTINATAIRES — partagée entre
// ProjectAction (Timeline) et CommercialContactRelance (follow-up
// commercial) : le CRM ne crée qu'UNE SEULE action/relance, mais Google
// Calendar doit recevoir le même événement dans PLUSIEURS calendriers
// (toujours info@probardistribution.com + le commercial concerné,
// dédupliqué par email s'ils sont identiques).
//
// Une ligne `CalendarEventSync` = un événement Google, pour un destinataire,
// pour une entité (`entityType`/`entityId`) — jamais un seul `googleEventId`
// global. Best-effort partout, comme googleCalendar.service.js sous-jacent.

const User = require("../models/User");
const UserProfile = require("../models/UserProfile");
const Task = require("../models/Task");
const CalendarEventSync = require("../models/CalendarEventSync");
const googleCalendarService = require("./googleCalendar.service");
const { sendEmail } = require("./email.service");

const FIXED_RECIPIENT_EMAIL = process.env.FOLLOWUP_FIXED_RECIPIENT_EMAIL || "info@probardistribution.com";

async function userInfo(userId) {
  if (!userId) return null;
  const [user, profile] = await Promise.all([
    User.findByPk(userId, { attributes: ["id", "email"] }),
    UserProfile.findOne({ where: { userId }, attributes: ["name"] }),
  ]);
  if (!user?.email) return null;
  return { userId: user.id, email: user.email, name: profile?.name || user.email };
}

async function userInfoByEmail(email) {
  if (!email) return null;
  const user = await User.findOne({ where: { email }, attributes: ["id", "email"] });
  if (!user) return null;
  return userInfo(user.id);
}

// Résout la liste dédupliquée (par email, insensible à la casse) des
// destinataires : toujours `fixedEmail`, plus `selectedUserId` s'il diffère.
// "Ne jamais créer de doublon" : si le commercial sélectionné EST déjà
// info@probardistribution.com, un seul destinataire est retourné.
async function resolveRecipients({ fixedEmail = FIXED_RECIPIENT_EMAIL, selectedUserId } = {}) {
  const recipients = [];
  const seenEmails = new Set();

  const fixed = await userInfoByEmail(fixedEmail);
  if (fixed) {
    recipients.push(fixed);
    seenEmails.add(fixed.email.toLowerCase());
  } else {
    console.warn(`[MultiRecipientCalendarSync] Destinataire fixe introuvable : ${fixedEmail}`);
  }

  if (selectedUserId) {
    const selected = await userInfo(selectedUserId);
    if (selected && !seenEmails.has(selected.email.toLowerCase())) {
      recipients.push(selected);
      seenEmails.add(selected.email.toLowerCase());
    }
  }

  return recipients;
}

async function upsertSync(entityType, entityId, userId, values) {
  const [row] = await CalendarEventSync.findOrCreate({
    where: { entityType, entityId, userId },
    defaults: { entityType, entityId, userId, ...values },
  });
  await row.update(values);
  return row;
}

// Crée ou met à jour l'événement Google pour CHAQUE destinataire. Ne lève
// jamais — chaque destinataire est indépendant (l'échec de l'un ne doit pas
// empêcher les autres). Retourne le détail par destinataire pour les logs.
async function syncEventForRecipients({
  entityType,
  entityId,
  recipients,
  summary,
  description,
  location,
  start,
  end,
  reminderMinutes,
}) {
  const results = [];

  for (const recipient of recipients) {
    const existing = await CalendarEventSync.findOne({
      where: { entityType, entityId, userId: recipient.userId },
    });

    const args = {
      userId: recipient.userId,
      summary,
      description,
      location,
      startDateTime: start,
      endDateTime: end,
      commercialLabel: recipient.name || recipient.email,
      reminderMinutes,
    };

    const result = existing?.googleEventId
      ? await googleCalendarService.updateCalendarEvent({ ...args, eventId: existing.googleEventId })
      : await googleCalendarService.createCalendarEvent(args);

    if (result.success && result.eventId) {
      await upsertSync(entityType, entityId, recipient.userId, {
        googleEventId: result.eventId,
        googleEventLink: result.eventLink || null,
        calendarId: result.calendarId || "primary",
        synced: true,
        error: null,
        googleUpdatedAt: new Date(),
      });
      console.log(`Calendrier : ${recipient.email}`);
      console.log(`Event ID   : ${result.eventId}`);
      results.push({ ...recipient, success: true, eventId: result.eventId, eventLink: result.eventLink });
    } else {
      await upsertSync(entityType, entityId, recipient.userId, {
        synced: false,
        error: result.skipped ? null : result.error || "Échec inconnu",
      });
      if (!result.skipped) {
        console.error(`Calendrier : ${recipient.email} → ÉCHEC : ${result.error || "Échec inconnu"}`);
      } else {
        console.log(`Calendrier : ${recipient.email} → non connecté (skip propre)`);
      }
      results.push({ ...recipient, success: false, skipped: result.skipped, error: result.error });
    }
  }

  return results;
}

// Crée ou met à jour le calendrier CRM (table `tasks`) de CHAQUE
// destinataire — BUG CORRIGÉ : auparavant une seule Task était créée, avec
// `createdBy` = le créateur/acteur uniquement (toujours info@...), donc le
// commercial affecté au projet ne voyait jamais la relance dans son propre
// Calendrier Follow-up (`GET /tasks` filtre par `Task.createdBy =
// req.user.sub`). Chaque destinataire reçoit maintenant SA PROPRE ligne
// `tasks`, trackée via `CalendarEventSync.taskId`.
async function syncTaskForRecipients({
  entityType,
  entityId,
  recipients,
  title,
  description,
  start,
  end,
  status = "planned",
  priority = null,
  projectId = null,
}) {
  const results = [];

  for (const recipient of recipients) {
    const existing = await CalendarEventSync.findOne({
      where: { entityType, entityId, userId: recipient.userId },
    });

    let task = existing?.taskId ? await Task.findByPk(existing.taskId) : null;
    if (task) {
      await task.update({ title, description, startAt: start, endAt: end, status, priority, createdBy: recipient.userId });
    } else {
      task = await Task.create({
        title, description, startAt: start, endAt: end, status, priority,
        createdBy: recipient.userId, projectId,
      });
    }

    await upsertSync(entityType, entityId, recipient.userId, { taskId: task.id });
    console.log(`Calendrier CRM créé — destinataire=${recipient.email} taskId=${task.id}`);
    results.push({ ...recipient, taskId: task.id });
  }

  return results;
}

// Supprime l'événement Google + le Task d'UN SEUL destinataire précis
// (utilisé lors d'une réassignation de responsable : l'ancien propriétaire
// quitte la liste des destinataires, info@probardistribution.com reste).
// N'affecte pas les autres destinataires de l'entité.
async function removeRecipient({ entityType, entityId, userId }) {
  const row = await CalendarEventSync.findOne({ where: { entityType, entityId, userId } });
  if (!row) return { attempted: false };

  if (row.googleEventId) {
    await googleCalendarService.deleteCalendarEvent({ userId, eventId: row.googleEventId });
  }
  if (row.taskId) {
    await Task.destroy({ where: { id: row.taskId } });
  }
  await row.destroy();
  return { attempted: true };
}

// Supprime l'événement Google + le Task de TOUS les destinataires déjà
// synchronisés pour cette entité, puis les lignes CalendarEventSync elles-mêmes.
async function deleteEventForRecipients({ entityType, entityId }) {
  const rows = await CalendarEventSync.findAll({ where: { entityType, entityId } });
  const results = [];

  for (const row of rows) {
    if (row.googleEventId) {
      const result = await googleCalendarService.deleteCalendarEvent({
        userId: row.userId,
        eventId: row.googleEventId,
      });
      console.log(`[MultiRecipientCalendarSync] Événement supprimé — userId=${row.userId} success=${result.success}`);
      results.push({ userId: row.userId, success: result.success });
    }
    if (row.taskId) {
      await Task.destroy({ where: { id: row.taskId } });
    }
  }

  await CalendarEventSync.destroy({ where: { entityType, entityId } });
  return results;
}

// Un email par destinataire unique (même liste dédupliquée que le calendrier).
async function sendEmailToRecipients({ recipients, subjectLabel, buildHtml, buildText }) {
  const sentTo = [];

  for (const recipient of recipients) {
    try {
      const html = buildHtml ? buildHtml(recipient) : undefined;
      const text = buildText ? buildText(recipient) : subjectLabel;
      const result = await sendEmail(recipient.email, subjectLabel, text, {}, html ? { html } : {});
      if (result.success) sentTo.push(recipient.email);
    } catch (err) {
      console.error(`❌ [MultiRecipientCalendarSync] Échec email — ${recipient.email}:`, err.message);
    }
  }

  console.log(`Emails envoyés : ${sentTo.length ? sentTo.join(", ") : "aucun"}`);
  return sentTo;
}

module.exports = {
  resolveRecipients,
  syncEventForRecipients,
  syncTaskForRecipients,
  removeRecipient,
  deleteEventForRecipients,
  sendEmailToRecipients,
  FIXED_RECIPIENT_EMAIL,
};
