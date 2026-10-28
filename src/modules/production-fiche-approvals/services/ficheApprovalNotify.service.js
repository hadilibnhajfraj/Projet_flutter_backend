"use strict";

// Notifications de la validation des fiches de production :
//   - nouvelle fiche (ou nouvelle soumission après refus) → responsable(s)
//     logistique(s) : notification dans l'application + email interne ;
//   - décision (validée / refusée) → créateur de la fiche.
// Chaque notification porte la fiche (type, id, n° de soumission) : elle
// s'ouvre directement depuis le centre de notifications. Une seule
// notification par destinataire, type, fiche et soumission (index unique
// partiel) et un seul email (file dédoublonnée enqueueEmailOnce) : une
// nouvelle tentative ne crée jamais de doublon. Un échec est journalisé et ne
// bloque jamais la création de la fiche ni la décision.

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { UniqueConstraintError } = require("sequelize");

const User = require("../../../models/User");
const Notification = require("../../../models/Notification");
const { enqueueEmailOnce } = require("../../../services/emailQueue.service");
const cfg = require("../../../config/productionFicheApproval");
const logger = require("../../../utils/logger");
const { emitToUser } = require("../../../socket");

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Africa/Tunis";
const CONTEXT = "production-fiche-approval";
const TYPES = Object.freeze({
  PENDING: "PRODUCTION_FICHE_PENDING",
  APPROVED: "PRODUCTION_FICHE_APPROVED",
  REJECTED: "PRODUCTION_FICHE_REJECTED",
});

const frDateTime = (d) => (d ? dayjs(d).tz(TZ).format("DD/MM/YYYY HH:mm") : "-");
const frDate = (d) => (d ? dayjs(d).format("DD/MM/YYYY") : "-");
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const link = (item) =>
  `${(process.env.CRM_BASE_URL || "https://www.crmprobar.com").replace(/\/+$/, "")}/production/validation-fiches?fiche=${item.ficheType}:${item.id}`;

/** Crée la notification si elle n'existe pas déjà (même destinataire, type, fiche, soumission). */
async function notifyOnce(userId, type, item, { title, message }) {
  try {
    await Notification.create({
      userId,
      type,
      title,
      message: message.slice(0, 500),
      isRead: false,
      productionFicheType: item.ficheType,
      productionFicheId: item.id,
      productionFicheVersion: item.version,
    });
    return true;
  } catch (e) {
    if (e instanceof UniqueConstraintError) return false; // déjà notifié pour cette soumission
    logger.error(`[FICHE-APPROVAL-NOTIFY] ${type} ${item.ficheType}/${item.id}: ${e.message}`);
    return false;
  }
}

function pendingLines(item, { resubmitted }) {
  return [
    ["Fiche", item.numero || item.id],
    ["Type de production", item.ficheTypeLabel],
    ["Machine", item.machine || "-"],
    ["Date de production", frDate(item.dateProduction)],
    ["Poste", item.posteLabel || item.poste || "-"],
    ["Producteur", item.creatorEmail || "-"],
    [resubmitted ? "Soumise de nouveau le" : "Créée le", frDateTime(resubmitted ? item.submittedAt : item.createdAt)],
    ["Statut", "En attente de validation"],
  ];
}

/** Nouvelle fiche (ou nouvelle soumission) → responsable(s) logistique(s). */
async function notifyPending(item, { resubmitted = false } = {}) {
  const lines = pendingLines(item, { resubmitted });
  const title = resubmitted ? "Fiche de production soumise de nouveau" : "Nouvelle fiche de production à valider";
  const message = lines.map(([k, v]) => `${k} : ${v}`).join(" · ");
  const users = await User.findAll({ where: { email: cfg.validators }, attributes: ["id", "email"] });
  for (const u of users) {
    const created = await notifyOnce(u.id, TYPES.PENDING, item, { title, message });
    // Email interne (jamais aux clients), dédoublonné par fiche et soumission.
    const subject = `${title} — ${item.numero || item.ficheTypeLabel}`;
    const text = `${lines.map(([k, v]) => `${k} : ${v}`).join("\n")}\n\nOuvrir : ${link(item)}`;
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827">
<p>${esc(title)}.</p><table cellpadding="4">${lines.map(([k, v]) => `<tr><td style="color:#6b7280">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table>
<p><a href="${esc(link(item))}">Ouvrir la fiche dans « Validation des fiches de production »</a></p></div>`;
    try {
      const out = await enqueueEmailOnce({
        dedupeKey: `${CONTEXT}:pending:${item.ficheType}:${item.id}:v${item.version}:${u.email}`,
        to: u.email,
        subject,
        text,
        html,
        context: CONTEXT,
        meta: { ficheType: item.ficheType, ficheId: item.id, version: item.version },
        userId: u.id,
      });
      logger.info(`[FICHE-APPROVAL-NOTIFY] pending ${item.ficheType}/${item.id} v${item.version} to=${u.email} notification=${created ? "créée" : "déjà présente"} email=${out.status}`);
    } catch (e) {
      logger.error(`[FICHE-APPROVAL-NOTIFY] email pending ${item.ficheType}/${item.id}: ${e.message}`);
    }
  }
}

/** Décision du responsable → créateur de la fiche. */
async function notifyDecision(item, createdBy) {
  const approved = item.status === "APPROVED";
  const ref = item.numero || item.id;
  await notifyOnce(
    createdBy,
    approved ? TYPES.APPROVED : TYPES.REJECTED,
    item,
    approved
      ? {
          title: "Votre fiche de production a été validée",
          message: `Votre fiche de production a été validée — ${ref}, par ${item.decidedByEmail} le ${frDateTime(item.decidedAt)}.`,
        }
      : {
          title: "Votre fiche de production a été refusée",
          message: `Votre fiche de production a été refusée — ${ref}, par ${item.decidedByEmail} le ${frDateTime(item.decidedAt)}. Motif : ${item.rejectionComment}. Veuillez corriger la fiche.`,
        }
  );
}

// Événement temps réel (sans notification) vers TOUS les responsables : leurs
// écrans de validation se relisent dès qu'une fiche est créée, soumise de
// nouveau ou décidée par un autre responsable. Émis après l'enregistrement.
async function broadcastUpdated(item) {
  try {
    const users = await User.findAll({ where: { email: cfg.validators }, attributes: ["id"] });
    for (const u of users) {
      emitToUser(u.id, "production-fiche-approval:updated", { ficheType: item.ficheType, id: item.id, status: item.status });
    }
  } catch (e) {
    logger.error(`[FICHE-APPROVAL-NOTIFY] broadcast ${item.ficheType}/${item.id}: ${e.message}`);
  }
}

module.exports = { TYPES, notifyPending, notifyDecision, broadcastUpdated };
