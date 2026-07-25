"use strict";

// Crée l'événement calendrier CRM (table `tasks`, déjà utilisée par l'écran
// Calendar existant) correspondant à un Follow-up planifié.

const dayjs = require("dayjs");
const Task = require("../models/Task");

function buildFollowupTaskContent({ contact, relance, projectName }) {
  const clientName = `${contact.nom || ""} ${contact.prenom || ""}`.trim() || "Client";
  const title = `Follow-up - ${clientName}`;

  const lines = [
    `Client : ${clientName}`,
    `Téléphone : ${contact.telephone || "-"}`,
    `Projet : ${projectName || "-"}`,
    `Commentaire : ${relance.commentaire || "-"}`,
    `Commercial : ${relance.commercialName || "-"}`,
    `Date : ${relance.dateRelance || "-"}`,
    `Heure : ${relance.heureRelance || "-"}`,
  ];
  if (contact.localisation) lines.push(`Lieu : ${contact.localisation}`);

  return { title, description: lines.join("\n") };
}

// `Task.startAt` combine date + heure en un seul DATE — pas de champ heure
// séparé sur ce modèle (réutilisé tel quel, aucune migration sur `tasks`).
function combineDateTime(dateRelance, heureRelance) {
  const time = heureRelance && /^\d{1,2}:\d{2}/.test(heureRelance) ? heureRelance : "09:00";
  const parsed = dayjs(`${dateRelance}T${time}`);
  return parsed.isValid() ? parsed.toDate() : new Date(dateRelance);
}

// Map statutRelance -> Task.status (enum "planned"|"done"|"canceled").
function taskStatusFromRelance(relance) {
  if (relance.statutRelance === "faite") return "done";
  if (relance.statutRelance === "annulee") return "canceled";
  return "planned";
}

// Crée l'événement calendrier interne s'il n'existe pas encore
// (relance.calendarEventId absent), sinon met à jour le même Task —
// évite d'empiler des doublons à chaque édition/report d'un Follow-up.
async function createFollowupTask({ contact, relance, projectName, actorUserId }, transaction) {
  const { title, description } = buildFollowupTaskContent({ contact, relance, projectName });
  const startAt = combineDateTime(relance.dateRelance, relance.heureRelance);
  const status = taskStatusFromRelance(relance);
  const opts = transaction ? { transaction } : undefined;

  if (relance.calendarEventId) {
    const existing = await Task.findByPk(relance.calendarEventId, opts);
    if (existing) {
      await existing.update({ title, description, startAt, status }, opts);
      return existing;
    }
  }

  return Task.create(
    { title, description, startAt, createdBy: actorUserId, projectId: null, status },
    opts
  );
}

module.exports = { createFollowupTask, buildFollowupTaskContent, combineDateTime, taskStatusFromRelance };
