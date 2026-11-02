"use strict";

// Notifications des notes de calcul (même principe que
// production-fiche-approvals/ficheApprovalNotify.service.js) :
//   - soumission / nouvelle soumission  → validateur (demande de validation) ;
//   - affectation / changement          → nouvel utilisateur affecté, et
//                                         l'ancien (affectation retirée) ;
//   - validation / refus                → créateur, demandeur, utilisateur
//                                         affecté (+ trace au validateur) ;
//   - annulation par le créateur        → validateur.
// Chaque destinataire reçoit une notification ENREGISTRÉE en base (lue plus
// tard s'il est hors ligne) et un email passant par la file d'envoi
// (email_queue : statut PENDING / RETRYING / SENT / FAILED conservé, une seule
// ligne par événement — dedupeKey). Serveur SMTP momentanément indisponible :
// l'email reste en file et est retenté (retryOnConnectionError) ; en échec
// définitif il peut être relancé (resendFailed). Un échec n'annule jamais
// l'opération déjà enregistrée et n'est jamais bloquant pour l'utilisateur.

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { UniqueConstraintError } = require("sequelize");

const { User, UserProfile, Project, Notification, CalculationNote, CalculationNoteDocument } = require("../../../models/associations");
const { enqueueEmailOnce } = require("../../../services/emailQueue.service");
const { resolveFullName } = require("../../../utils/userDisplay");
const { STATUS_LABELS } = require("../../../config/calculationNoteValidation");
const logger = require("../../../utils/logger");

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Africa/Tunis";
const CONTEXT = "calculation-note-validation";
const TYPES = Object.freeze({
  PENDING: "CALCULATION_NOTE_PENDING",
  RESUBMITTED: "CALCULATION_NOTE_RESUBMITTED",
  VALIDATED: "CALCULATION_NOTE_VALIDATED",
  REJECTED: "CALCULATION_NOTE_REJECTED",
  CANCELLED: "CALCULATION_NOTE_CANCELLED",
  ASSIGNED: "CALCULATION_NOTE_ASSIGNED",
  COMPLEMENTARY: "CALCULATION_NOTE_COMPLEMENTARY_DOCUMENTS",
  UNASSIGNED: "CALCULATION_NOTE_UNASSIGNED",
});

const DOCUMENT_TYPE_LABELS = { note_de_calcul: "Note de calcul", plan: "Plan", hypotheses: "Hypothèses", metre: "Métré", rapport: "Rapport", annexe: "Annexe", autre: "Autre" };

const frDateTime = (d) => (d ? dayjs(d).tz(TZ).format("DD/MM/YYYY HH:mm") : "-");
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const noteLink = (id) => `${(process.env.CRM_BASE_URL || "https://www.crmprobar.com").replace(/\/+$/, "")}/notes-calcul/detail?id=${id}`;
const nameOf = (u) => resolveFullName(u) || "-";

// Envois en cours (après la réponse HTTP) — attendus par les tests.
const inflight = new Set();
function runAfterResponse(fn) {
  const p = Promise.resolve()
    .then(fn)
    .catch((e) => logger.error(`[CALCULATION-NOTE-NOTIFY] ${e.message}`))
    .finally(() => inflight.delete(p));
  inflight.add(p);
  return p;
}
async function flushNotifications() {
  while (inflight.size) await Promise.all([...inflight]);
}

const userInc = (as) => ({ model: User, as, attributes: ["id", "email", "isActive"], include: [{ model: UserProfile, as: "profile", attributes: ["name", "prenom", "nom"], required: false }] });

async function loadNote(id) {
  return CalculationNote.findByPk(id, {
    include: [
      { model: Project, as: "project", attributes: ["id", "nomProjet"] },
      userInc("requester"),
      userInc("creator"),
      userInc("validator"),
      userInc("decider"),
      userInc("canceller"),
      userInc("assignee"),
      userInc("assigner"),
      { model: CalculationNoteDocument, as: "documents", attributes: ["id", "originalName", "title", "documentType", "commentaire", "origin", "createdAt"] },
    ],
    order: [[{ model: CalculationNoteDocument, as: "documents" }, "createdAt", "ASC"]],
  });
}

async function notifyOnce(userId, type, note, version, { title, message }) {
  try {
    await Notification.create({
      userId,
      type,
      title: title.slice(0, 200),
      message: message.slice(0, 500),
      isRead: false,
      calculationNoteId: note.id,
      calculationNoteVersion: version,
    });
    return true;
  } catch (e) {
    if (e instanceof UniqueConstraintError) return false; // déjà notifié pour cet événement
    logger.error(`[CALCULATION-NOTE-NOTIFY] ${type} note=${note.id}: ${e.message}`);
    return false;
  }
}

const docLine = (d) => {
  const type = d.documentType ? ` [${DOCUMENT_TYPE_LABELS[d.documentType] || d.documentType}]` : "";
  const comment = d.commentaire ? ` — ${d.commentaire}` : "";
  return `${d.originalName}${type}${comment}`;
};

function documentsText(note) {
  const docs = (note.documents || []).filter((d) => d.origin !== "COMPLEMENTARY");
  if (!docs.length) return "Aucun document pour le moment";
  return docs.map(docLine).join(" ; "); // nom réel du fichier
}

// Contenu commun : référence, projet, demandeur, créateur, utilisateur
// affecté, date de création, observations, documents, motif éventuel, statut.
function lines(note, { comment, withAssignee = true, withDocuments = true } = {}) {
  return [
    ["Référence", note.reference],
    ["Projet", note.project?.nomProjet || "-"],
    ["Demandeur", nameOf(note.requester)],
    ["Créateur", nameOf(note.creator)],
    ...(withAssignee ? [["Utilisateur affecté", note.assignee ? `${nameOf(note.assignee)} (${note.assignee.email})` : "Aucun"]] : []),
    ["Date de création", frDateTime(note.createdAt)],
    ["Observations générales", note.commentaire || "-"],
    ...(withDocuments ? [["Documents techniques", documentsText(note)]] : []),
    ...(comment ? [[comment[0], comment[1]]] : []),
    ["Statut", STATUS_LABELS[note.status] || note.status],
  ];
}

async function send(user, type, note, { title, subject, greeting, intro, closing, comment, version = note.submissionVersion, linkLabel = "Consulter la note dans le CRM", withAssignee = true, rows: customRows }) {
  if (!user || user.isActive === false) return;
  const rows = customRows || lines(note, { comment, withAssignee });
  const hello = greeting ? `${greeting}\n\n` : "";
  const message = `${intro} ${rows.filter(([k]) => k !== "Documents techniques").map(([k, v]) => `${k} : ${v}`).join(" · ")}`;
  const created = await notifyOnce(user.id, type, note, version, { title, message });
  const link = noteLink(note.id);
  const text = `${hello}${intro}\n\n${rows.map(([k, v]) => `${k} : ${v}`).join("\n")}${closing ? `\n\n${closing}` : ""}\n\n${linkLabel} : ${link}`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827">
${greeting ? `<p>${esc(greeting)}</p>` : ""}<p>${esc(intro)}</p><table cellpadding="4">${rows.map(([k, v]) => `<tr><td style="color:#6b7280;vertical-align:top">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table>
${closing ? `<p>${esc(closing)}</p>` : ""}<p><a href="${esc(link)}">${esc(linkLabel)}</a></p></div>`;
  try {
    const out = await enqueueEmailOnce({
      dedupeKey: `${CONTEXT}:${type}:${note.id}:v${version}:${user.email}`,
      to: user.email,
      subject: subject || `${title} — ${note.reference}`,
      text,
      html,
      context: CONTEXT,
      // Panne SMTP temporaire : l'email reste en file et est retenté.
      meta: { calculationNoteId: note.id, version, type, retryOnConnectionError: true },
      userId: user.id,
    });
    logger.info(`[CALCULATION-NOTE-NOTIFY] ${type} note=${note.id} v${version} to=${user.email} notification=${created ? "créée" : "déjà présente"} email=${out.status}`);
  } catch (e) {
    logger.error(`[CALCULATION-NOTE-NOTIFY] email ${type} note=${note.id}: ${e.message}`);
  }
}

/** Note soumise (ou soumise de nouveau après refus) → demande de validation. */
function notifySubmitted(noteId, { resubmitted = false } = {}) {
  return runAfterResponse(async () => {
    const note = await loadNote(noteId);
    if (!note?.validator) return;
    await send(note.validator, resubmitted ? TYPES.RESUBMITTED : TYPES.PENDING, note, {
      title: resubmitted ? "Note de calcul soumise de nouveau" : "Nouvelle demande de validation",
      subject: resubmitted ? `Note de calcul soumise de nouveau – ${note.reference}` : `Nouvelle demande de validation – Note de calcul ${note.reference}`,
      intro: resubmitted
        ? `La note de calcul ${note.reference} a été modifiée et soumise de nouveau à votre validation.`
        : "Une nouvelle note de calcul a été créée et nécessite votre validation. Veuillez consulter les informations et les documents associés, puis valider ou refuser la demande.",
      linkLabel: "Ouvrir la page de validation",
    });
  });
}

/** Affectation (création ou changement) → nouvel utilisateur ; l'ancien est informé du retrait. */
function notifyAssignment(noteId, { previousUserId = null } = {}) {
  return runAfterResponse(async () => {
    const note = await loadNote(noteId);
    if (!note) return;
    const version = note.assignmentVersion;
    if (note.assignee) {
      await send(note.assignee, TYPES.ASSIGNED, note, {
        title: "Nouvelle note de calcul qui vous est affectée",
        subject: `Nouvelle note de calcul qui vous est affectée – ${note.reference}`,
        greeting: `Bonjour ${nameOf(note.assignee)},`,
        intro: "Une nouvelle note de calcul vous a été affectée.",
        closing: "Vous avez été désigné comme utilisateur responsable de cette note de calcul. Merci de consulter les informations et les documents associés.",
        version,
        withAssignee: false,
      });
    }
    if (previousUserId && previousUserId !== note.assignedToUserId) {
      const previous = await User.findByPk(previousUserId, { attributes: ["id", "email", "isActive"], include: [{ model: UserProfile, as: "profile", attributes: ["name", "prenom", "nom"], required: false }] });
      await send(previous, TYPES.UNASSIGNED, note, {
        title: "Affectation retirée",
        subject: `Affectation retirée – Note de calcul ${note.reference}`,
        greeting: `Bonjour ${nameOf(previous)},`,
        intro: `Vous n'êtes plus l'utilisateur responsable de la note de calcul ${note.reference} (modification par ${nameOf(note.assigner)} le ${frDateTime(note.assignedAt)}).`,
        version,
      });
    }
  });
}

/** Documents complémentaires déposés par l'utilisateur affecté → créateur, demandeur, validateur. */
function notifyComplementaryDocuments(noteId, { version, uploaderId, documentIds = [] }) {
  return runAfterResponse(async () => {
    const note = await loadNote(noteId);
    if (!note) return;
    const uploader = await User.findByPk(uploaderId, { attributes: ["id", "email"], include: [{ model: UserProfile, as: "profile", attributes: ["name", "prenom", "nom"], required: false }] });
    const docs = (note.documents || []).filter((d) => documentIds.includes(d.id));
    const types = [...new Set(docs.map((d) => (d.documentType ? DOCUMENT_TYPE_LABELS[d.documentType] || d.documentType : "Non précisé")))];
    const comments = docs.filter((d) => d.commentaire).map((d) => `${d.originalName} : ${d.commentaire}`);
    const rows = [
      ["Référence", note.reference],
      ["Projet", note.project?.nomProjet || "-"],
      ["Ajoutés par", `${nameOf(uploader)} (${uploader?.email || "-"})`],
      ["Nombre de documents ajoutés", String(docs.length)],
      ["Types de documents", types.join(", ") || "-"],
      ["Documents", docs.map(docLine).join(" ; ") || "-"],
      ["Commentaires", comments.join(" ; ") || "Aucun commentaire"],
      ["Statut", STATUS_LABELS[note.status] || note.status],
    ];
    const recipients = new Map();
    for (const u of [note.creator, note.requester, note.validator]) if (u && u.id !== uploaderId) recipients.set(u.id, u);
    for (const u of recipients.values()) {
      const isValidator = u.id === note.validatorId;
      await send(u, TYPES.COMPLEMENTARY, note, {
        title: "Documents complémentaires ajoutés",
        subject: `Documents complémentaires ajoutés – Note de calcul ${note.reference}`,
        intro: `${nameOf(uploader)}, utilisateur affecté, a ajouté ${docs.length} document(s) complémentaire(s) à la note de calcul ${note.reference}.${isValidator && note.status === "EN_ATTENTE_VALIDATION" ? " La note reste en attente de votre décision." : ""}`,
        rows,
        version,
        linkLabel: isValidator ? "Ouvrir la page de validation" : "Consulter la note dans le CRM",
      });
    }
  });
}

/** Décision du validateur → créateur, demandeur, utilisateur affecté, + trace au validateur. */
function notifyDecision(noteId) {
  return runAfterResponse(async () => {
    const note = await loadNote(noteId);
    if (!note) return;
    const validated = note.status === "VALIDEE";
    const type = validated ? TYPES.VALIDATED : TYPES.REJECTED;
    const by = `${nameOf(note.decider)} le ${frDateTime(note.decidedAt)}`;
    const comment = note.decisionComment ? [validated ? "Commentaire du validateur" : "Motif du refus", note.decisionComment] : null;
    const recipients = new Map();
    for (const u of [note.creator, note.requester, note.assignee]) if (u) recipients.set(u.id, u);
    for (const u of recipients.values()) {
      await send(u, type, note, {
        title: validated ? "Note de calcul validée" : "Note de calcul refusée",
        intro: validated ? `La note de calcul ${note.reference} a été validée par ${by}.` : `La note de calcul ${note.reference} a été refusée par ${by}.`,
        comment,
      });
    }
    if (note.validator && !recipients.has(note.validator.id)) {
      // Décision du validateur : trace ; décision du back-office : information.
      const own = note.decidedBy === note.validator.id;
      await send(note.validator, type, note, {
        title: validated ? "Trace : note de calcul validée" : "Trace : note de calcul refusée",
        intro: own
          ? `Vous avez ${validated ? "validé" : "refusé"} la note de calcul ${note.reference} (${frDateTime(note.decidedAt)}).`
          : `La note de calcul ${note.reference} a été ${validated ? "validée" : "refusée"} par ${by}. Aucune décision n'est plus attendue de votre part.`,
        comment,
      });
    }
  });
}

/** Annulation par le créateur → validateur. */
function notifyCancelled(noteId) {
  return runAfterResponse(async () => {
    const note = await loadNote(noteId);
    if (!note?.validator) return;
    await send(note.validator, TYPES.CANCELLED, note, {
      title: "Note de calcul annulée par son créateur",
      intro: `La note de calcul ${note.reference} a été annulée par ${nameOf(note.canceller)} le ${frDateTime(note.cancelledAt)}. Aucune décision n'est plus attendue.`,
      comment: ["Motif de l'annulation", note.cancellationReason],
    });
  });
}

module.exports = { TYPES, CONTEXT, notifySubmitted, notifyAssignment, notifyComplementaryDocuments, notifyDecision, notifyCancelled, flushNotifications };
