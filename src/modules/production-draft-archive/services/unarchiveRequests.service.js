"use strict";

// Demandes de désarchivage d'une fiche PROMESH/PROBAR archivée automatiquement
// (voir draftArchive.service.js). Même architecture que
// production-compliance/services/requests.service.js (créer → PENDING →
// notifier les responsables → approuver/refuser) — réutilise DIRECTEMENT les
// responsables déjà configurés du contrôle de production (cfg.managers /
// isComplianceManagerUser) au lieu d'un nouveau système de permissions, et le
// même modèle Notification pour ne jamais créer de notification "console
// uniquement".

const { sequelize } = require("../../../db");
const ProductionUnarchiveRequest = require("../../../models/ProductionUnarchiveRequest");
const ProductionDraftArchiveLog = require("../../../models/ProductionDraftArchiveLog");
const Notification = require("../../../models/Notification");
const User = require("../../../models/User");
const PorPromesh = require("../../../models/PorPromesh");
const IndustrialRecord = require("../../../models/IndustrialRecord");
const porPromeshRepo = require("../../por-promesh/repositories/porPromesh.repository");
const logger = require("../../../utils/logger");
// Réutilise cfg.managers / isComplianceManagerUser / notifyManagers / findUserByEmail
// du module production-compliance — mêmes responsables que le contrôle
// PROD1/PROD2, jamais un 2e système de permissions/notifications.
const compliance = require("../../production-compliance/services/compliance.service");
const { PERMISSIONS } = require("../../../config/productionWorkflow");
const workflowNotify = require("../../production-requests/services/notify.service");

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function assertManager(managerId, transaction, permission) {
  const manager = await User.findByPk(managerId, { attributes: ["id", "email", "role", "isActive"], transaction });
  if (!manager || manager.isActive === false || !compliance.hasProductionPermission(manager, permission)) {
    throw new AppError(403, "NOT_A_MANAGER", "Only a production compliance manager can do this.");
  }
  return manager;
}

function assertFicheType(ficheType) {
  if (ficheType !== "PROMESH" && ficheType !== "PROBAR") {
    throw new AppError(400, "INVALID_FICHE_TYPE", "ficheType must be PROMESH or PROBAR.");
  }
}

async function loadFiche(ficheType, ficheId, transaction) {
  return ficheType === "PROMESH"
    ? PorPromesh.findByPk(ficheId, { transaction })
    : IndustrialRecord.findByPk(ficheId, { transaction });
}

function ficheIsArchived(ficheType, fiche) {
  return ficheType === "PROMESH" ? fiche.status === "ARCHIVED" : fiche.statut === "archivee";
}

// Remet la fiche exactement dans son statut brouillon d'origine et
// renseigne unarchivedAt/unarchivedBy DIRECTEMENT sur la fiche (même
// exigence que archivedAt/archivedBy/archiveReason à l'archivage — voir
// draftArchive.service.js). archivedAt/archivedBy/archiveReason sont remis à
// NULL : la fiche n'est alors plus "actuellement archivée" (cohérent avec le
// WHERE status=DRAFT AND archivedAt IS NULL utilisé par le sweep) ; le cycle
// complet (date d'archivage, motif, qui a désarchivé) reste consultable dans
// le journal d'audit production_draft_archive_log, jamais perdu.
async function unarchiveFiche(ficheType, fiche, { manager, now }, transaction) {
  const patch = { archivedAt: null, archivedBy: null, archiveReason: null, unarchivedAt: now, unarchivedBy: manager.email };
  if (ficheType === "PROMESH") await porPromeshRepo.update(fiche, { status: "BROUILLON", ...patch }, transaction);
  else await fiche.update({ statut: "enregistree", ...patch }, { transaction });
}

function viewRequest(r) {
  return {
    id: r.id,
    ficheType: r.ficheType,
    ficheId: r.ficheId,
    userId: r.userId,
    userEmail: r.userEmail,
    dateProduction: r.dateProduction,
    machine: r.machine,
    poste: r.poste,
    ficheCreatedAt: r.ficheCreatedAt,
    archivedAt: r.archivedAt,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requestedAt,
    reviewedAt: r.reviewedAt,
    reviewedBy: r.reviewedBy,
    reviewerEmail: r.reviewerEmail,
    reviewNote: r.reviewNote,
  };
}

// ── Création par le propriétaire de la fiche ─────────────────────────────
async function createUnarchiveRequest({ userId, email, ficheType, ficheId, reason }) {
  assertFicheType(ficheType);
  if (!reason || !String(reason).trim()) {
    throw new AppError(400, "REASON_REQUIRED", "A reason is required.");
  }

  const out = await sequelize.transaction(async (t) => {
    const fiche = await loadFiche(ficheType, ficheId, t);
    if (!fiche) throw new AppError(404, "NOT_FOUND", "Fiche introuvable.");
    // Jamais confiance au frontend : le propriétaire réel (createdBy) est
    // revérifié depuis la fiche elle-même, jamais depuis un champ envoyé par
    // le client.
    if (fiche.createdBy !== userId) {
      throw new AppError(403, "NOT_OWNER", "Vous ne pouvez demander le désarchivage que de vos propres fiches.");
    }
    if (!ficheIsArchived(ficheType, fiche)) {
      throw new AppError(409, "NOT_ARCHIVED", "Cette fiche n'est pas archivée.");
    }

    // §8-like : jamais de 2e demande PENDING pour la même fiche (contrainte
    // unique en base en filet de sécurité — voir migration).
    const existing = await ProductionUnarchiveRequest.findOne({ where: { ficheType, ficheId, status: "PENDING" }, transaction: t, lock: t.LOCK.UPDATE });
    if (existing) return { request: viewRequest(existing), alreadyPending: true };

    const log = await ProductionDraftArchiveLog.findOne({ where: { ficheType, ficheId }, order: [["archivedAt", "DESC"]], transaction: t });

    const row = await ProductionUnarchiveRequest.create(
      {
        ficheType,
        ficheId,
        userId,
        userEmail: email,
        dateProduction: ficheType === "PROMESH" ? fiche.dateProduction : fiche.dateFiche,
        machine: fiche.machine,
        poste: fiche.poste,
        ficheCreatedAt: fiche.createdAt,
        archivedAt: log?.archivedAt || fiche.updatedAt,
        reason: String(reason).trim().slice(0, 1000),
        status: "PENDING",
        requestedAt: new Date(),
      },
      { transaction: t }
    );
    return { row };
  });

  if (out.request) return out; // déjà PENDING : rien de plus à faire
  const { row } = out;

  const notified = await compliance.notifyManagers({
    type: "production_unarchive_request",
    title: `Demande de désarchivage — ${row.ficheType}`,
    message: `${row.userEmail} demande le désarchivage de sa fiche ${row.ficheType} du ${row.dateProduction || "-"} (machine ${row.machine || "-"}, poste ${row.poste || "-"}). Motif : ${row.reason}`,
  });
  // Email du workflow Production (productioncbiftunisia@gmail.com) —
  // idempotent (une demande = un email), jamais au client.
  await workflowNotify.notifyUnarchiveRequestCreated(row);
  logger.info(`[production-draft-archive] UNARCHIVE REQUEST CREATED request=${row.id} user=${row.userEmail} fiche=${row.ficheType}#${row.ficheId} notified=${notified}`);
  return { request: viewRequest(row), alreadyPending: false };
}

// ── Lecture ──────────────────────────────────────────────────────────────
async function listRequests({ status, ficheType, userId } = {}) {
  const where = {};
  if (ficheType) where.ficheType = ficheType;
  if (userId) where.userId = userId;
  if (status) where.status = status;
  const rows = await ProductionUnarchiveRequest.findAll({ where, order: [["requestedAt", "DESC"]], limit: 500 });
  return rows.map(viewRequest);
}

async function myRequests(userId) {
  const rows = await ProductionUnarchiveRequest.findAll({ where: { userId }, order: [["requestedAt", "DESC"]], limit: 100 });
  return rows.map(viewRequest);
}

async function requestStats() {
  const rows = await ProductionUnarchiveRequest.findAll({ attributes: ["status"] });
  const stats = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  for (const r of rows) stats[r.status] = (stats[r.status] || 0) + 1;
  return stats;
}

async function loadPendingForUpdate(id, transaction) {
  const row = await ProductionUnarchiveRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw new AppError(404, "NOT_FOUND", "Demande introuvable.");
  if (row.status !== "PENDING") {
    throw new AppError(409, "INVALID_STATE", `Cette demande est déjà ${row.status}.`);
  }
  return row;
}

// ── Décision du responsable ───────────────────────────────────────────────
async function approveUnarchiveRequest({ managerId, id, note }) {
  const now = new Date();
  const { row, manager } = await sequelize.transaction(async (t) => {
    const manager = await assertManager(managerId, t, PERMISSIONS.ARCHIVE_APPROVE);
    const row = await loadPendingForUpdate(id, t);

    const fiche = await loadFiche(row.ficheType, row.ficheId, t);
    if (!fiche) throw new AppError(404, "FICHE_NOT_FOUND", "Fiche introuvable.");
    if (!ficheIsArchived(row.ficheType, fiche)) {
      throw new AppError(409, "NOT_ARCHIVED", "Cette fiche n'est déjà plus archivée.");
    }

    await unarchiveFiche(row.ficheType, fiche, { manager, now }, t);
    await row.update(
      { status: "APPROVED", reviewedAt: now, reviewedBy: manager.id, reviewerEmail: manager.email, reviewNote: note ? String(note).trim().slice(0, 1000) : null },
      { transaction: t }
    );

    const log = await ProductionDraftArchiveLog.findOne({ where: { ficheType: row.ficheType, ficheId: row.ficheId }, order: [["archivedAt", "DESC"]], transaction: t });
    if (log) await log.update({ unarchivedAt: now, unarchivedBy: manager.id, unarchivedByEmail: manager.email }, { transaction: t });

    return { row, manager };
  });

  try {
    await Notification.create({
      userId: row.userId,
      type: "production_unarchive_approved",
      title: "Désarchivage approuvé",
      message: `Votre demande de désarchivage a été approuvée. Vous pouvez maintenant modifier la fiche.`.slice(0, 500),
    });
  } catch (err) {
    logger.error(`[production-draft-archive] notification approbation échouée: ${err.message}`);
  }
  logger.info(`[production-draft-archive] UNARCHIVE APPROVED request=${row.id} by=${manager.email} fiche=${row.ficheType}#${row.ficheId}`);
  return { request: viewRequest(row) };
}

async function rejectUnarchiveRequest({ managerId, id, note }) {
  if (!note || !String(note).trim()) {
    throw new AppError(400, "REASON_REQUIRED", "A reason is required to reject this request.");
  }
  const now = new Date();
  const { row, manager } = await sequelize.transaction(async (t) => {
    const manager = await assertManager(managerId, t, PERMISSIONS.ARCHIVE_REJECT);
    const row = await loadPendingForUpdate(id, t);
    await row.update(
      { status: "REJECTED", reviewedAt: now, reviewedBy: manager.id, reviewerEmail: manager.email, reviewNote: String(note).trim().slice(0, 1000) },
      { transaction: t }
    );
    return { row, manager };
  });

  try {
    await Notification.create({
      userId: row.userId,
      type: "production_unarchive_rejected",
      title: "Désarchivage refusé",
      message: `Votre demande de désarchivage a été refusée. Motif : ${row.reviewNote || "-"}`.slice(0, 500),
    });
  } catch (err) {
    logger.error(`[production-draft-archive] notification refus échouée: ${err.message}`);
  }
  logger.info(`[production-draft-archive] UNARCHIVE REJECTED request=${row.id} by=${manager.email} fiche=${row.ficheType}#${row.ficheId}`);
  return { request: viewRequest(row) };
}

module.exports = {
  AppError,
  createUnarchiveRequest,
  listRequests,
  myRequests,
  requestStats,
  approveUnarchiveRequest,
  rejectUnarchiveRequest,
};
