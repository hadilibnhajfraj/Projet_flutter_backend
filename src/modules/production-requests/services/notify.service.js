"use strict";

// Emails du workflow des demandes Production (responsable logistique) :
//   - "[PRODUCTION] Nouvelle demande d'autorisation"  (backfill)
//   - "[PRODUCTION] Nouvelle demande de désarchivage"
//
// Règles :
// - destinataire(s) = config/productionWorkflow.js#notifyRecipients
//   (productioncbiftunisia@gmail.com) — JAMAIS une adresse issue de la demande ;
// - garde-fou : toute adresse connue comme contact externe (client, revendeur,
//   architecte, ingénieur) est refusée avant envoi, même si mal configurée ;
// - idempotent : dedupeKey = type + id de la demande + destinataire (UNIQUE
//   en base, voir emailQueue.service#enqueueEmailOnce) → une demande = un email ;
// - envoi via la file EmailQueue existante (SENT uniquement si le SMTP
//   accepte ; retries uniquement sur erreur SMTP temporaire).
// Ne lève jamais : un échec email ne bloque jamais la création de la demande.

const { QueryTypes } = require("sequelize");
const { sequelize } = require("../../../db");
const workflowCfg = require("../../../config/productionWorkflow");
const complianceCfg = require("../../../config/productionCompliance");
const { enqueueEmailOnce } = require("../../../services/emailQueue.service");
const compliance = require("../../production-compliance/services/compliance.service");
const logger = require("../../../utils/logger");

const CONTEXT = "production_workflow";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Adresses de contacts EXTERNES connues du CRM (clients/prospects,
// revendeurs, architectes, ingénieurs, dallagistes) — jamais destinataires
// de ce workflow interne.
async function findExternalContactEmails(emails) {
  if (!emails.length) return new Set();
  const rows = await sequelize.query(
    `SELECT lower(e) AS email FROM (
        SELECT email AS e FROM commercial_contacts
        UNION ALL SELECT email FROM architects
        UNION ALL SELECT email FROM engineers
        UNION ALL SELECT "revendeurEmail" FROM projects
        UNION ALL SELECT "emailArchitecte" FROM projects
        UNION ALL SELECT "emailIngenieur" FROM projects
        UNION ALL SELECT "emailDallagiste" FROM projects
      ) x WHERE lower(e) IN (:emails)`,
    { replacements: { emails }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.email));
}

async function safeRecipients() {
  const configured = [...new Set(workflowCfg.notifyRecipients)];
  let external;
  try {
    external = await findExternalContactEmails(configured);
  } catch (err) {
    // Impossible de vérifier → on n'envoie rien plutôt que risquer un client.
    logger.error(`[PRODUCTION-WORKFLOW-MAIL] vérification des destinataires impossible, aucun envoi: ${err.message}`);
    return [];
  }
  for (const e of external) logger.error(`[PRODUCTION-WORKFLOW-MAIL] destinataire REFUSÉ (contact externe/client) : ${e}`);
  return configured.filter((e) => !external.has(e));
}

function productionOf(email) {
  return compliance.getMonitoredByEmail(email);
}

function buildEmail({ subject, heading, rows }) {
  const link = complianceCfg.crmBaseUrl;
  const text = [
    "--------------------------------------------------",
    heading,
    "--------------------------------------------------",
    "",
    "Une nouvelle demande nécessite votre validation.",
    "",
    ...rows.flatMap(([k, v]) => [`${k} :`, v, ""]),
    "Veuillez consulter l'application PROBAR pour traiter cette demande.",
    link,
    "",
    "PROBAR — CBI Tunisia",
    "--------------------------------------------------",
  ].join("\n");
  const tr = (k, v) => `<tr><td style="padding:4px 14px 4px 0;color:#555;vertical-align:top">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<h2 style="margin:0 0 12px">${esc(heading)}</h2>
<p>Une nouvelle demande nécessite votre validation.</p>
<table>${rows.map(([k, v]) => tr(k, v)).join("")}</table>
<p>Veuillez consulter l'application PROBAR pour traiter cette demande.</p>
<p><a href="${esc(link)}">Ouvrir l'application PROBAR</a></p>
<p style="color:#777">PROBAR — CBI Tunisia</p></div>`;
  return { subject, text, html };
}

async function send(kind, requestId, message) {
  const recipients = await safeRecipients();
  const results = [];
  for (const to of recipients) {
    const out = await enqueueEmailOnce({
      dedupeKey: `${CONTEXT}:${kind}:${requestId}:${to}`,
      to,
      ...message,
      context: CONTEXT,
      meta: { kind, requestId },
    });
    logger.info(`[PRODUCTION-WORKFLOW-MAIL] ${kind} request=${requestId} to=${to} status=${out.status}${out.duplicate ? " (doublon ignoré)" : ""}`);
    results.push({ to, ...out });
  }
  return results;
}

function requestedAtFr(date) {
  return compliance.tzNow(date || new Date()).format("DD/MM/YYYY HH:mm");
}

async function notifyAuthorizationRequestCreated(row) {
  try {
    const prod = complianceCfg.productions[row.productionType];
    const dates = (Array.isArray(row.missingDates) && row.missingDates.length ? row.missingDates : [row.missingDate]).map(compliance.frDate);
    const message = buildEmail({
      subject: "[PRODUCTION] Nouvelle demande d'autorisation",
      heading: "PROBAR — Demande Production",
      rows: [
        ["Utilisateur", row.userEmail],
        ["Email", row.userEmail],
        ["Production", prod?.label || row.productionType],
        ["Date(s) concernée(s)", dates.join(", ")],
        ["Type", "Autorisation de backfill"],
        ["Motif", row.reason || "-"],
        ["Date de la demande", requestedAtFr(row.requestedAt)],
      ],
    });
    return await send("authorization", row.id, message);
  } catch (err) {
    logger.error(`[PRODUCTION-WORKFLOW-MAIL] authorization request=${row?.id} non notifiée: ${err.message}`);
    return [];
  }
}

async function notifyUnarchiveRequestCreated(row) {
  try {
    const prod = productionOf(row.userEmail);
    const message = buildEmail({
      subject: "[PRODUCTION] Nouvelle demande de désarchivage",
      heading: "PROBAR — Demande Production",
      rows: [
        ["Utilisateur", row.userEmail],
        ["Email", row.userEmail],
        ["Production", prod?.label || row.ficheType],
        ["Date concernée", row.dateProduction ? compliance.frDate(row.dateProduction) : "-"],
        ["Type", `Désarchivage de fiche ${row.ficheType}`],
        ["Motif", row.reason || "-"],
        ["Date de la demande", requestedAtFr(row.requestedAt)],
      ],
    });
    return await send("unarchive", row.id, message);
  } catch (err) {
    logger.error(`[PRODUCTION-WORKFLOW-MAIL] unarchive request=${row?.id} non notifiée: ${err.message}`);
    return [];
  }
}

module.exports = {
  CONTEXT,
  notifyAuthorizationRequestCreated,
  notifyUnarchiveRequestCreated,
  findExternalContactEmails,
};
