"use strict";

const { resolveFullName } = require("../../../utils/userDisplay");

function toEmployeeRef(user) {
  if (!user) return null;
  const u = user.toJSON ? user.toJSON() : user;
  return { id: u.id, email: u.email, role: u.role };
}

function toReviewerRef(user) {
  if (!user) return null;
  const u = user.toJSON ? user.toJSON() : user;
  return { id: u.id, email: u.email, name: resolveFullName(u) };
}

function toHrRequestResponse(record) {
  if (!record) return null;
  const r = record.toJSON ? record.toJSON() : record;

  return {
    id: r.id,
    ticketNo: r.ticketNo,
    type: r.type,
    statut: r.statut,

    requestedBy: r.requestedBy,
    employee: toEmployeeRef(r.employee),

    employeeNom: r.employeeNom,
    employeePrenom: r.employeePrenom,
    employeeMatricule: r.employeeMatricule,
    employeeQualification: r.employeeQualification,
    employeeDepartement: r.employeeDepartement,
    employeeService: r.employeeService,
    employeeEmail: r.employeeEmail,

    typeConge: r.typeConge,
    dateDebut: r.dateDebut,
    dateFin: r.dateFin,
    nombreJours: r.nombreJours,
    anneeConge: r.anneeConge,
    adresse: r.adresse,
    telephone: r.telephone,

    motif: r.motif,
    dateSortie: r.dateSortie,
    heureSortie: r.heureSortie,
    heureRetour: r.heureRetour,

    commentaire: r.commentaire,
    signature: r.signature,

    emailSentAt: r.emailSentAt,

    reviewComment: r.reviewComment,
    reviewedAt: r.reviewedAt,
    reviewedByUser: toReviewerRef(r.reviewedByUser),
    processedAt: r.processedAt,
    processedByUser: toReviewerRef(r.processedByUser),
    justificatifs: r.justificatifs || [],

    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toHrRequestList(records) {
  return records.map(toHrRequestResponse);
}

module.exports = { toHrRequestResponse, toHrRequestList };
