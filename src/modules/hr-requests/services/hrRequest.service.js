"use strict";

const PDFDocument = require("pdfkit");
const dayjs = require("dayjs");

const repo = require("../repositories/hrRequest.repository");
const HrRequestActivity = require("../../../models/HrRequestActivity");
const Notification = require("../../../models/Notification");
const UserProfile = require("../../../models/UserProfile");
const User = require("../../../models/User");
const { sendEmail } = require("../../../services/email.service");
const { emitToUser } = require("../../../socket");
const { resolveFullName } = require("../../../utils/userDisplay");
const { isHrReviewer } = require("../../../middleware/requireHrReviewer");
const { HR_MANAGER_EMAIL } = require("../../../config/hrManager");
const logger = require("../../../utils/logger");
require("../../../models/associations");

// Adresse fixe du Responsable RH — destinataire de toute nouvelle demande RH.
const MANAGER_OFFICE_EMAIL = HR_MANAGER_EMAIL;
// Base de l'app web, utilisée uniquement pour construire le lien "Consulter
// la demande" dans l'email — n'affecte pas l'API elle-même.
const APP_BASE_URL = process.env.APP_WEB_URL || "https://www.crmprobar.com";

function isReviewer(role, email) {
  return isHrReviewer(role, email);
}

// Jours ouvrables (lundi-vendredi) entre deux dates, bornes incluses — ne
// tient pas compte des jours fériés (aucun calendrier fourni à ce jour).
function countBusinessDays(startISO, endISO) {
  let count = 0;
  let cur = dayjs(startISO).startOf("day");
  const end = dayjs(endISO).startOf("day");
  while (!cur.isAfter(end)) {
    const dow = cur.day(); // 0 = dimanche, 6 = samedi
    if (dow !== 0 && dow !== 6) count += 1;
    cur = cur.add(1, "day");
  }
  return count;
}

function assertOwnership(record, actor) {
  if (!isReviewer(actor.role, actor.email) && record.requestedBy !== actor.id) {
    throw { status: 403, message: "Vous ne pouvez accéder qu'à vos propres demandes" };
  }
}

async function _getHrManager() {
  return User.findOne({ where: { email: MANAGER_OFFICE_EMAIL }, attributes: ["id", "email"] });
}

// ── Création ────────────────────────────────────────────────────────────

// Le profil RH (UserProfile) est la source prioritaire pour chaque champ ;
// si le profil ne contient pas encore la valeur, on utilise celle fournie
// dans la requête (saisie manuellement par l'utilisateur dans le formulaire,
// puisque le formulaire ne bloque plus l'accès en cas de profil incomplet).
function pickEmployeeField(profileValue, bodyValue) {
  const fromProfile = (profileValue ?? "").toString().trim();
  if (fromProfile) return fromProfile;
  const fromBody = (bodyValue ?? "").toString().trim();
  return fromBody || null;
}

async function createRequest(body, actor, photoPaths = []) {
  const profile = await UserProfile.findOne({ where: { userId: actor.id } });
  const user = await User.findByPk(actor.id);

  const snapshot = {
    employeeNom: pickEmployeeField(profile?.nom, body.employeeNom),
    employeePrenom: pickEmployeeField(profile?.prenom, body.employeePrenom),
    employeeMatricule: pickEmployeeField(profile?.matricule, body.employeeMatricule),
    employeeQualification: pickEmployeeField(profile?.qualification, body.employeeQualification),
    employeeDepartement: pickEmployeeField(profile?.departement, body.employeeDepartement),
    employeeService: pickEmployeeField(profile?.service, body.employeeService),
    employeeEmail: user?.email ?? null,
  };

  // Garde-fou serveur : le formulaire empêche déjà l'envoi tant que ces
  // champs sont vides (bouton désactivé), ceci ne fait que le vérifier.
  const fieldLabels = {
    employeeNom: "Nom",
    employeePrenom: "Prénom",
    employeeMatricule: "Matricule",
    employeeQualification: "Qualification",
    employeeDepartement: "Département",
    employeeService: "Service",
  };
  const missing = Object.keys(fieldLabels).filter((k) => !snapshot[k]);
  if (missing.length) {
    throw {
      status: 422,
      message: `Informations employé manquantes : ${missing.map((k) => fieldLabels[k]).join(", ")}.`,
    };
  }

  const signature = `${snapshot.employeeNom} ${snapshot.employeePrenom}`.trim();

  let data = {
    type: body.type,
    requestedBy: actor.id,
    statut: "en_attente",
    signature,
    commentaire: body.commentaire ?? null,
    justificatifs: photoPaths,
    ...snapshot,
  };

  if (body.type === "conge") {
    const debut = dayjs(body.dateDebut);
    data = {
      ...data,
      typeConge: body.typeConge,
      dateDebut: body.dateDebut,
      dateFin: body.dateFin,
      nombreJours: countBusinessDays(body.dateDebut, body.dateFin),
      anneeConge: debut.year(),
      adresse: body.adresse,
      telephone: body.telephone,
    };
  } else {
    data = {
      ...data,
      motif: body.motif,
      dateSortie: body.dateSortie,
      heureSortie: body.heureSortie,
      heureRetour: body.heureRetour,
      telephone: body.telephone ?? null,
    };
  }

  const created = await repo.create(data);
  const full = await repo.findById(created.id);

  await HrRequestActivity.create({
    requestId: created.id,
    userId: actor.id,
    type: "created",
    message: "Demande créée.",
  });

  // Notification interne + email + socket au Responsable RH — jamais
  // bloquant : une erreur ici ne doit jamais faire échouer la création.
  try {
    const manager = await _getHrManager();
    if (manager) {
      await Notification.create({
        userId: manager.id,
        type: "HR_REQUEST_CREATED",
        title: "Nouvelle demande RH",
        message: "Une nouvelle demande de congé/autorisation est en attente de validation.",
        hrRequestId: created.id,
        isRead: false,
      });
      emitToUser(manager.id, "hr-request-created", { requestId: created.id, type: data.type });
    }

    const pdfBuffer = await getHrRequestPdfBuffer(full);
    await sendHrRequestEmail(full, pdfBuffer);
    await repo.update(full, { emailSentAt: new Date() });
  } catch (e) {
    logger.error("HR_REQUEST_EMAIL_ERROR:", e);
  }

  return repo.findById(created.id);
}

// ── Lecture / Liste ─────────────────────────────────────────────────────

async function listRequests(filters, actor) {
  const where = isReviewer(actor.role, actor.email) ? {} : { requestedBy: actor.id };
  if (filters.type) where.type = filters.type;
  if (filters.statut) where.statut = filters.statut;
  return repo.findAll(where);
}

async function getRequestById(id, actor) {
  const record = await repo.findById(id);
  if (!record) throw { status: 404, message: "Demande introuvable" };
  assertOwnership(record, actor);
  return record;
}

// ── Workflow de validation (Responsable RH) ─────────────────────────────

async function acceptRequest(id, actor, comment) {
  const record = await repo.findById(id);
  if (!record) throw { status: 404, message: "Demande introuvable" };
  if (record.statut !== "en_attente") throw { status: 400, message: "Cette demande a déjà été traitée" };

  const reviewedAt = new Date();
  await repo.update(record, {
    statut: "acceptee",
    reviewedBy: actor.id,
    reviewedAt,
    reviewComment: comment || record.reviewComment,
  });

  await HrRequestActivity.create({
    requestId: id,
    userId: actor.id,
    type: "accepted",
    message: "Demande acceptée.",
    metadata: { reviewedBy: actor.id, reviewedAt, comment: comment || null },
  });

  await _notifyRequester(record, {
    type: "HR_REQUEST_ACCEPTED",
    title: "Votre demande a été acceptée.",
    message: comment ? `Votre demande RH a été acceptée. Commentaire : ${comment}` : "Votre demande RH a été acceptée.",
    event: "hr-request-accepted",
    emailSubject: "Votre demande a été acceptée.",
    comment,
  });

  return repo.findById(id);
}

async function rejectRequest(id, actor, comment) {
  const record = await repo.findById(id);
  if (!record) throw { status: 404, message: "Demande introuvable" };
  if (record.statut !== "en_attente") throw { status: 400, message: "Cette demande a déjà été traitée" };

  const reviewedAt = new Date();
  await repo.update(record, {
    statut: "refusee",
    reviewedBy: actor.id,
    reviewedAt,
    reviewComment: comment || record.reviewComment,
  });

  await HrRequestActivity.create({
    requestId: id,
    userId: actor.id,
    type: "rejected",
    message: "Demande refusée.",
    metadata: { reviewedBy: actor.id, reviewedAt, comment: comment || null },
  });

  await _notifyRequester(record, {
    type: "HR_REQUEST_REJECTED",
    title: "Votre demande a été refusée.",
    message: comment ? `Votre demande RH a été refusée. Commentaire : ${comment}` : "Votre demande RH a été refusée.",
    event: "hr-request-rejected",
    emailSubject: "Votre demande a été refusée.",
    comment,
  });

  return repo.findById(id);
}

async function markProcessed(id, actor) {
  const record = await repo.findById(id);
  if (!record) throw { status: 404, message: "Demande introuvable" };
  if (record.statut !== "acceptee") throw { status: 400, message: "Seule une demande acceptée peut être marquée traitée" };

  const processedAt = new Date();
  await repo.update(record, { statut: "traitee", processedBy: actor.id, processedAt });

  await HrRequestActivity.create({
    requestId: id,
    userId: actor.id,
    type: "processed",
    message: "Demande marquée comme traitée.",
    metadata: { processedBy: actor.id, processedAt },
  });

  await _notifyRequester(record, {
    type: "HR_REQUEST_PROCESSED",
    title: "Votre demande a été traitée.",
    message: "Votre demande RH a été traitée par le Responsable RH.",
    event: "hr-request-processed",
    emailSubject: "Votre demande a été traitée.",
  });

  return repo.findById(id);
}

async function addComment(id, actor, comment) {
  if (!isReviewer(actor.role, actor.email)) {
    throw { status: 403, message: "Seul le Responsable RH peut ajouter un commentaire" };
  }
  const record = await repo.findBareById(id);
  if (!record) throw { status: 404, message: "Demande introuvable" };

  await repo.update(record, { reviewComment: comment });

  await HrRequestActivity.create({
    requestId: id,
    userId: actor.id,
    type: "commented",
    message: "Commentaire ajouté.",
    metadata: { comment },
  });

  return repo.findById(id);
}

async function _notifyRequester(record, { type, title, message, event, emailSubject, comment }) {
  await Notification.create({
    userId: record.requestedBy,
    type,
    title,
    message,
    hrRequestId: record.id,
    isRead: false,
  });

  emitToUser(record.requestedBy, event, { requestId: record.id, message });

  const requesterEmail = record.employeeEmail || record.employee?.email;
  if (requesterEmail) {
    const requesterName = `${record.employeeNom || ""} ${record.employeePrenom || ""}`.trim() || "Utilisateur";
    const isConge = record.type === "conge";
    const text =
      `Bonjour ${requesterName},\n\n` +
      `${message}\n\n` +
      (comment ? `Commentaire du Responsable RH :\n${comment}\n\n` : "") +
      `Type de demande : ${isConge ? "Congé" : "Autorisation de sortie"}\n` +
      `Merci.`;

    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#0F172A;">
        <h2 style="margin-bottom:4px;">${emailSubject}</h2>
        <p style="color:#64748B;margin-top:0;">${isConge ? "Demande de congé" : "Autorisation de sortie"}</p>
        <p>${message}</p>
        ${comment ? `<div style="background:#F1F5F9;border-left:4px solid #2563EB;border-radius:0 8px 8px 0;padding:12px 16px;margin:16px 0;"><b>Commentaire du Responsable RH :</b><br/>${comment}</div>` : ""}
      </div>
    `;

    sendEmail(requesterEmail, emailSubject, text, { hrRequestId: record.id }, { html }).catch((e) =>
      logger.error("HR_REQUEST_DECISION_EMAIL_ERROR:", e)
    );
  }
}

async function getHistory(id, actor) {
  const record = await repo.findBareById(id);
  if (!record) throw { status: 404, message: "Demande introuvable" };
  assertOwnership(record, actor);

  const activities = await HrRequestActivity.findAll({
    where: { requestId: id },
    include: [
      {
        model: User,
        as: "actor",
        attributes: ["id", "email"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
        required: false,
      },
    ],
    order: [["createdAt", "ASC"]],
  });

  return activities.map((a) => {
    const j = a.toJSON();
    return { ...j, actor: j.actor ? { id: j.actor.id, email: j.actor.email, name: resolveFullName(j.actor) } : null };
  });
}

async function deleteRequest(id, actor) {
  const record = await repo.findBareById(id);
  if (!record) throw { status: 404, message: "Demande introuvable" };
  assertOwnership(record, actor);

  if (!isReviewer(actor.role, actor.email) && record.statut !== "en_attente") {
    throw { status: 403, message: "Une demande déjà traitée ne peut plus être supprimée" };
  }

  await repo.destroy(record);
  return { id };
}

// ── PDF (pdfkit) ─────────────────────────────────────────────────────────
//
// buildCongePdf reproduit la structure du formulaire officiel CBI "Demande
// de Congé" : seule la première partie (saisie employé) est remplie
// automatiquement. La section "TITRE DE CONGÉ" (Accord / Refus / Signature
// du supérieur hiérarchique) est volontairement laissée VIDE — elle est
// réservée aux Ressources Humaines et complétée manuellement plus tard.
// Mise en page provisoire (pas de scan de référence reçu à ce jour) mais
// respecte exactement la liste de champs demandée. buildSortiePdf reste
// inchangé (hors périmètre de cette refonte).

function row(doc, label, value) {
  doc.font("Helvetica-Bold").text(`${label}: `, { continued: true }).font("Helvetica").text(value ?? "-");
}

function sectionTitle(doc, title) {
  doc.moveDown(0.5).font("Helvetica-Bold").fontSize(13).text(title).fontSize(10).moveDown(0.3);
}

function fmtDate(value) {
  if (!value) return "-";
  return dayjs(value).format("DD/MM/YYYY");
}

function buildHrRequestPdf(r) {
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  return r.type === "conge" ? buildCongePdf(doc, r) : buildSortiePdf(doc, r);
}

function buildCongePdf(doc, r) {
  doc.fontSize(16).font("Helvetica-Bold").text("CBI — Demande de Congé", { align: "center" });
  doc.fontSize(10).font("Helvetica").text(`Référence : ${r.id}`, { align: "center" });
  doc.moveDown();

  // ── Partie 1 : renseignée automatiquement par le système ─────────────────
  sectionTitle(doc, "Informations Employé");
  row(doc, "Nom", r.employeeNom);
  row(doc, "Prénom", r.employeePrenom);
  row(doc, "Matricule", r.employeeMatricule);
  row(doc, "Qualification", r.employeeQualification);

  sectionTitle(doc, "Détails de la Demande");
  row(doc, "Type de congé", r.typeConge === "maladie" ? "Congé maladie" : "Congé ordinaire");
  row(doc, "Date de la demande", fmtDate(r.createdAt));
  row(doc, "Date début", fmtDate(r.dateDebut));
  row(doc, "Date fin", fmtDate(r.dateFin));
  row(doc, "Nombre de jours ouvrables", r.nombreJours);
  row(doc, "Année", r.anneeConge);
  row(doc, "Adresse pendant le congé", r.adresse);
  row(doc, "Téléphone", r.telephone);

  // ── Partie 2 : "TITRE DE CONGÉ" — réservée RH, laissée vide ──────────────
  doc.moveDown(1);
  doc.font("Helvetica-Bold").fontSize(13).text("TITRE DE CONGÉ", { underline: true });
  doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("gray")
    .text("Section réservée aux Ressources Humaines — à compléter manuellement.");
  doc.fillColor("black").font("Helvetica").fontSize(10).moveDown(0.6);
  doc.text("Accord :        ☐");
  doc.moveDown(0.4);
  doc.text("Refus :         ☐");
  doc.moveDown(0.4);
  doc.text("Signature du supérieur hiérarchique : ____________________________________");

  doc.moveDown(2);
  doc.fontSize(8).fillColor("gray").text(`Date de génération : ${dayjs().format("DD/MM/YYYY HH:mm")}`, {
    align: "center",
  });

  return doc;
}

function buildSortiePdf(doc, r) {
  doc.fontSize(16).font("Helvetica-Bold").text("CBI — Autorisation de Sortie", { align: "center" });
  doc.fontSize(10).font("Helvetica").text(`Référence : ${r.id}`, { align: "center" });
  doc.moveDown();

  sectionTitle(doc, "Informations Employé");
  row(doc, "Nom", r.employeeNom);
  row(doc, "Prénom", r.employeePrenom);
  row(doc, "Matricule", r.employeeMatricule);
  row(doc, "Qualification", r.employeeQualification);
  row(doc, "Département", r.employeeDepartement);
  row(doc, "Service", r.employeeService);
  row(doc, "Email", r.employeeEmail);

  sectionTitle(doc, "Autorisation de Sortie");
  row(doc, "Motif", r.motif);
  row(doc, "Date", fmtDate(r.dateSortie));
  row(doc, "Heure de sortie", r.heureSortie);
  row(doc, "Heure de retour", r.heureRetour);

  if (r.commentaire) {
    sectionTitle(doc, "Commentaire");
    doc.font("Helvetica").text(r.commentaire);
  }

  sectionTitle(doc, "Statut & Traçabilité");
  row(doc, "Statut", statutLabel(r.statut));
  row(doc, "Date de la demande", dayjs(r.createdAt).format("DD/MM/YYYY HH:mm"));
  row(doc, "Signature numérique", r.signature);

  doc.moveDown(2);
  doc.fontSize(8).fillColor("gray").text(`Généré automatiquement le ${dayjs().format("DD/MM/YYYY HH:mm")}`, {
    align: "center",
  });

  return doc;
}

function statutLabel(statut) {
  if (statut === "acceptee") return "Acceptée";
  if (statut === "refusee") return "Refusée";
  if (statut === "traitee") return "Traitée";
  return "En attente";
}

function pdfDocToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

async function getHrRequestPdfBuffer(record) {
  const doc = buildHrRequestPdf(record.toJSON ? record.toJSON() : record);
  return pdfDocToBuffer(doc);
}

async function getHrRequestPdf(id, actor) {
  const record = await getRequestById(id, actor);
  return buildHrRequestPdf(record.toJSON ? record.toJSON() : record);
}

// ── Email automatique (Responsable RH) ──────────────────────────────────

async function sendHrRequestEmail(record, pdfBuffer) {
  const r = record.toJSON ? record.toJSON() : record;
  const isConge = r.type === "conge";
  const consultUrl = `${APP_BASE_URL}/#/forms/hr-requests/${isConge ? "conge" : "sortie"}?id=${r.id}`;
  const createdAtLabel = dayjs(r.createdAt).format("DD/MM/YYYY HH:mm");

  const lines = [
    "Bonjour,",
    "",
    "Une nouvelle demande RH a été créée.",
    "",
    `Type : ${isConge ? "Congé" : "Autorisation"}`,
    "",
    "Informations :",
    `Nom : ${r.employeeNom || "-"}`,
    `Prénom : ${r.employeePrenom || "-"}`,
    `Email : ${r.employeeEmail || "-"}`,
    `Département : ${r.employeeDepartement || "-"}`,
    `Service : ${r.employeeService || "-"}`,
    `Matricule : ${r.employeeMatricule || "-"}`,
    `Qualification : ${r.employeeQualification || "-"}`,
    `Date début : ${isConge ? fmtDate(r.dateDebut) : fmtDate(r.dateSortie)}`,
    `Date fin : ${isConge ? fmtDate(r.dateFin) : "-"}`,
    `Nombre de jours : ${isConge ? (r.nombreJours ?? "-") : "-"}`,
    `Motif : ${isConge ? "-" : (r.motif || "-")}`,
    `Date de création : ${createdAtLabel}`,
    "",
    `Consulter la demande : ${consultUrl}`,
  ];

  const infoRow = (label, value) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#64748B;">${label}</td><td><b>${value ?? "-"}</b></td></tr>`;

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#0F172A;">
      <p>Bonjour,</p>
      <p>Une nouvelle demande RH a été créée.</p>
      <h2 style="margin-bottom:4px;">${isConge ? "Congé" : "Autorisation"}</h2>
      <table style="border-collapse:collapse;margin:12px 0;">
        ${infoRow("Nom", r.employeeNom)}
        ${infoRow("Prénom", r.employeePrenom)}
        ${infoRow("Email", r.employeeEmail)}
        ${infoRow("Département", r.employeeDepartement)}
        ${infoRow("Service", r.employeeService)}
        ${infoRow("Matricule", r.employeeMatricule)}
        ${infoRow("Qualification", r.employeeQualification)}
        ${infoRow("Date début", isConge ? fmtDate(r.dateDebut) : fmtDate(r.dateSortie))}
        ${infoRow("Date fin", isConge ? fmtDate(r.dateFin) : "-")}
        ${infoRow("Nombre de jours", isConge ? r.nombreJours : "-")}
        ${infoRow("Motif", isConge ? "-" : r.motif)}
        ${infoRow("Date de création", createdAtLabel)}
      </table>
      <a href="${consultUrl}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold;">Consulter la demande</a>
    </div>
  `;

  return sendEmail(
    MANAGER_OFFICE_EMAIL,
    "Nouvelle demande RH",
    lines.join("\n"),
    { hrRequestId: r.id, type: r.type },
    {
      html,
      attachments: [
        {
          filename: `demande-rh-${r.id}.pdf`,
          content: pdfBuffer,
        },
      ],
    }
  );
}

module.exports = {
  createRequest,
  listRequests,
  getRequestById,
  acceptRequest,
  rejectRequest,
  markProcessed,
  addComment,
  getHistory,
  deleteRequest,
  getHrRequestPdf,
  getHrRequestPdfBuffer,
};
