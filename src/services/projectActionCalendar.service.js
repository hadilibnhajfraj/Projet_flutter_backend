"use strict";

// Crée/met à jour l'événement calendrier CRM (table `tasks`, écran Calendar
// existant) correspondant à une action de la Timeline d'un projet.
//
// Généralise calendar.service.js (déjà utilisé pour les Follow-up commerciaux)
// à ProjectAction — même contrat : idempotent via action.calendarEventId,
// Task.createdBy = l'agent dont le calendrier doit afficher l'événement
// (PAS forcément qui a créé l'action).

const Task = require("../models/Task");

const DEFAULT_DURATION_MS = 60 * 60 * 1000; // 1h

// Début = dateRelance (date du rendez-vous choisie dans le formulaire) si
// présente, sinon dateAction (horodatage de création de l'action).
function resolveActionWindow(action) {
  const start = action.dateRelance || action.dateAction;
  const end = action.dateFin || new Date(new Date(start).getTime() + DEFAULT_DURATION_MS);
  return { start: new Date(start), end: new Date(end) };
}

function actionLabel(action) {
  return action.typeAction_legacy || "Action";
}

function buildActionCalendarContent({ action, project, ownerName }) {
  const title = `${actionLabel(action)} - ${project.entreprise || project.nomProjet || "Projet"}`;

  const lines = [
    `Projet : ${project.nomProjet || "-"}`,
    `Client : ${project.entreprise || "-"}`,
    `Commentaire : ${action.commentaire || "-"}`,
    `Responsable : ${ownerName || "-"}`,
    `Statut : ${action.statut || "-"}`,
    `Priorité : ${action.priorite || "normale"}`,
  ];

  const appBaseUrl = process.env.APP_WEB_URL || "https://www.crmprobar.com";
  lines.push(`Projet CRM : ${appBaseUrl}/forms/project-timeline?projectId=${project.id}`);

  return { title, description: lines.join("\n") };
}

// Crée le Task s'il n'existe pas encore (action.calendarEventId absent),
// sinon met à jour le même Task — évite d'empiler des doublons à chaque
// édition de l'action.
async function syncCalendarTask({ action, project, ownerId, ownerName }, transaction) {
  const { title, description } = buildActionCalendarContent({ action, project, ownerName });
  const { start, end } = resolveActionWindow(action);
  const opts = transaction ? { transaction } : undefined;

  if (action.calendarEventId) {
    const existing = await Task.findByPk(action.calendarEventId, opts);
    if (existing) {
      await existing.update(
        {
          title,
          description,
          startAt: start,
          endAt: end,
          priority: action.priorite || "normale",
          createdBy: ownerId, // suit le propriétaire courant du projet
        },
        opts
      );
      return existing;
    }
  }

  return Task.create(
    {
      title,
      description,
      startAt: start,
      endAt: end,
      priority: action.priorite || "normale",
      createdBy: ownerId,
      projectId: project.id,
      status: "planned",
    },
    opts
  );
}

async function deleteCalendarTask(calendarEventId, transaction) {
  if (!calendarEventId) return;
  const opts = transaction ? { transaction } : undefined;
  await Task.destroy({ where: { id: calendarEventId }, ...opts });
}

module.exports = {
  resolveActionWindow,
  actionLabel,
  buildActionCalendarContent,
  syncCalendarTask,
  deleteCalendarTask,
};
