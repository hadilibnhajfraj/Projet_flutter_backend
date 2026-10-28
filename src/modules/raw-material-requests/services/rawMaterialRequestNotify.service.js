"use strict";

// Notifications du circuit de validation des demandes de matières premières :
//   - soumission / nouvelle soumission → validateurs (notification CRM + email) ;
//   - validation / rejet → demandeur (notification CRM) ;
//   - échéance du vendredi 14 h dépassée → demandeur et validateurs.
// Mêmes mécanismes que les demandes Production (Notification + file d'emails
// dédoublonnée enqueueEmailOnce). Une notification qui échoue ne bloque
// jamais l'enregistrement de la demande : l'erreur est journalisée.

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

const User = require("../../../models/User");
const Notification = require("../../../models/Notification");
const { enqueueEmailOnce } = require("../../../services/emailQueue.service");
const cfg = require("../../../config/rawMaterialRequest");
const logger = require("../../../utils/logger");
const { emitToUser } = require("../../../socket");

dayjs.extend(utc);
dayjs.extend(timezone);

const TYPE = "raw_material_request";
const CONTEXT = "raw-material-request";
const fr = (d) => (d ? dayjs(d).tz(cfg.TZ).format("DD/MM/YYYY HH:mm") : "-");
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const link = () => `${(process.env.CRM_BASE_URL || "https://www.crmprobar.com").replace(/\/+$/, "")}/production/matieres-premieres`;

async function validatorUsers() {
  return User.findAll({ where: { email: cfg.validators }, attributes: ["id", "email"] });
}

async function notifyUsers(users, title, message, row) {
  for (const u of users) {
    await Notification.create({
      userId: u.id,
      type: TYPE,
      title: title.slice(0, 200),
      message: message.slice(0, 500),
      // Ouverture directe de la demande depuis la notification.
      rawMaterialRequestId: row?.id || null,
    });
  }
}

// Résumé des matières demandées pour la notification (« ISO 15 KG, … »).
function itemsShort(row) {
  return (row.items || []).map((i) => `${i.label} ${i.quantiteDemandee} ${i.unite || "KG"}`).join(", ");
}

function itemsText(row) {
  return (row.items || [])
    .map((i) => `${i.label} : demandé ${i.quantiteDemandee} ${i.unite || "KG"} (disponible ${i.quantiteDisponible}, besoin ${i.besoinProduction})`)
    .join("\n");
}

async function emailValidators(kind, row, subject, intro) {
  const rows = [
    ["N° de demande", row.requestNumber],
    ["Demandeur", row.userEmail],
    ["Poste", row.poste === "matin" ? "Matin" : "Soir"],
    ["Date de production", dayjs(row.productionDate).format("DD/MM/YYYY")],
    ["Validation requise avant", fr(row.deadlineAt)],
  ];
  const text = `${intro}\n\n${rows.map(([k, v]) => `${k} : ${v}`).join("\n")}\n\n${itemsText(row)}\n\n${link()}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<h2 style="margin:0 0 12px">PROBAR — Demande de matières premières</h2>
<p>${esc(intro)}</p>
<table>${rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join("")}</table>
<p style="white-space:pre-line">${esc(itemsText(row))}</p>
<p><a href="${esc(link())}">Ouvrir le suivi des matières premières</a></p></div>`;
  for (const to of cfg.validators) {
    const out = await enqueueEmailOnce({
      dedupeKey: `${CONTEXT}:${kind}:${row.id}:${new Date(row.updatedAt || Date.now()).getTime()}:${to}`,
      to,
      subject,
      text,
      html,
      context: CONTEXT,
      meta: { kind, requestId: row.id },
    });
    logger.info(`[RAW-MATERIAL-REQUEST-MAIL] ${kind} ${row.requestNumber} to=${to} status=${out.status}`);
  }
}

// Événement temps réel (sans notification ni historique) vers TOUS les
// responsables : leurs écrans relisent la demande dès qu'un autre responsable
// l'a traitée — aucune seconde décision sur un écran périmé (le backend la
// refuse de toute façon). Émis après l'enregistrement.
async function broadcastUpdated(row) {
  try {
    for (const u of await validatorUsers()) {
      emitToUser(u.id, "raw-material-request:updated", { id: row.id, status: row.status });
    }
  } catch (e) {
    logger.error(`[RAW-MATERIAL-REQUEST] broadcast failed: ${e.message}`);
  }
}

async function safe(label, fn) {
  try {
    await fn();
  } catch (e) {
    logger.error(`[RAW-MATERIAL-REQUEST] notification ${label} failed: ${e.message}`);
  }
}

function notifySubmitted(row, { resubmitted = false } = {}) {
  return safe("submitted", async () => {
    const title = resubmitted ? "Demande de matières premières corrigée" : "Demande de matières premières à valider";
    const message =
      `${row.requestNumber} — Producteur : ${row.userEmail} · Poste : ${row.poste === "matin" ? "Matin" : "Soir"} · ` +
      `Date : ${dayjs(row.productionDate).format("DD/MM/YYYY")} · Matières : ${itemsShort(row)} · Statut : En attente · ` +
      `validation requise avant le ${fr(row.deadlineAt)}.`;
    await notifyUsers(await validatorUsers(), title, message, row);
    await emailValidators(
      resubmitted ? "resubmitted" : "submitted",
      row,
      `[MATIÈRES PREMIÈRES] ${resubmitted ? "Demande corrigée" : "Nouvelle demande"} ${row.requestNumber} à valider`,
      resubmitted
        ? "Une demande de matières premières rejetée a été corrigée et soumise à nouveau. Elle nécessite votre validation."
        : "Une nouvelle demande de matières premières nécessite votre validation."
    );
  });
}

function notifyDecision(row, { status, comment, byEmail }) {
  return safe("decision", async () => {
    const validated = status === cfg.STATUSES.VALIDATED;
    const title = validated ? "Demande de matières premières validée" : "Demande de matières premières rejetée";
    const decidedAt = validated ? row.validatedAt : row.rejectedAt;
    const message =
      `${row.requestNumber} ${validated ? "validée" : "rejetée"} par ${byEmail} le ${fr(decidedAt || new Date())}` +
      `${comment ? ` — Motif : « ${comment} »` : "."}`;
    await notifyUsers([{ id: row.userId }], title, message, row);
  });
}

function notifyLate(row) {
  return safe("late", async () => {
    const title = "Demande de matières premières en retard";
    const message = `${row.requestNumber} n'a pas été validée avant le ${fr(row.deadlineAt)}.`;
    await notifyUsers([{ id: row.userId }, ...(await validatorUsers())], title, message, row);
    await emailValidators("late", row, `[MATIÈRES PREMIÈRES] ${row.requestNumber} en retard de validation`,
      "L'échéance de validation est dépassée : cette demande est toujours en attente de validation.");
  });
}

// Refus du shift soir : le responsable logistique est notifié (CRM + email).
function notifyEveningRefused(row, { comment, byEmail }) {
  return safe("evening-refused", async () => {
    const title = "Demande de matières premières refusée par le shift soir";
    const message = `${row.requestNumber} refusée par ${byEmail} : « ${comment} »`;
    await notifyUsers(await validatorUsers(), title, message, row);
    await emailValidators(
      "evening-refused",
      row,
      `[MATIÈRES PREMIÈRES] ${row.requestNumber} refusée par le shift soir`,
      `La demande validée a été refusée par le shift soir (${byEmail}). Motif : « ${comment} ».`
    );
  });
}

module.exports = { notifySubmitted, notifyDecision, notifyLate, notifyEveningRefused, broadcastUpdated, TYPE };
