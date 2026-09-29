"use strict";

// ═══════════════════════════════════════════════════════════════════════
// Archivage automatique des brouillons PROMESH/PROBAR après 8h
// (§MODIFICATION 2026-09-29 : délai porté de 2h à 8h — seul le délai change,
// règle/requête/cron/journal identiques ; voir DRAFT_ARCHIVE_DELAY_HOURS).
//
// CORRECTION (ticket précédent) : la version d'origine exemptait une fiche
// déjà "complète" (mêmes champs que la validation manuelle/24h :
// dateProduction/heureDebut/heureFin côté PROMESH). Ces 3 champs sont en
// réalité PRÉ-REMPLIS AUTOMATIQUEMENT à la création (voir
// porPromesh.service.createOrOpenDraft) — donc PRESQUE TOUT brouillon réel
// était jugé "complet" et jamais archivé, rendant la règle des 2h inopérante
// en pratique (confirmé sur PROMESH-2026-000449 : 5h43 d'âge réel, toujours
// BROUILLON). La règle des 2h s'applique donc À TOUTE fiche encore en
// brouillon après 2h, sans exception de "complétude" — exactement la requête
// demandée :
//   WHERE status = DRAFT AND createdAt <= NOW() - INTERVAL '8 hours'
//     AND archivedAt IS NULL
//
// CE TICKET (re-vérification scheduler) : en plus du statut, chaque fiche
// archivée reçoit désormais DIRECTEMENT (pas seulement dans le journal
// d'audit production_draft_archive_log) :
//   archivedAt = NOW(), archivedBy = "SYSTEM", archiveReason = REASON
// et le format des logs est enrichi (CHECK avec compteurs drafts/expired,
// blocs ARCHIVING / ARCHIVED SUCCESSFULLY par fiche) pour permettre une
// vérification visuelle immédiate que le scheduler tourne réellement, même
// quand il n'y a rien à archiver.
//
// La règle des 24h (déverrouillage automatique, voir
// cron/ficheAutoValidation.job.js) n'a donc plus d'effet pratique pour un
// brouillon jamais touché dans les 2h — il sera archivé avant. Elle reste
// utile pour un brouillon modifié/complété entre 2h et 24h après création :
// tant qu'il reste BROUILLON il peut encore être archivé (aucune borne
// haute), mais une fois VALIDE il n'est plus jamais concerné par aucune des
// deux règles.
//
// Ne supprime rien : la fiche et toutes ses données restent en base, seul
// son statut change (BROUILLON → ARCHIVED côté PROMESH, "enregistree" →
// "archivee" côté PROBAR), et un désarchivage (Super Admin) la remet
// exactement dans son statut brouillon d'origine — createdAt jamais modifié.
//
// Idempotence / concurrence (§13) : chaque archivage passe par un UPDATE
// CONDITIONNEL (WHERE id=... AND status=<toujours brouillon>) et vérifie le
// nombre de lignes réellement affectées — si 0 (une autre instance backend
// vient de la traiter en même temps), on passe la fiche sans dupliquer le
// journal d'audit ni la notification. Le WHERE du sweep lui-même exclut déjà
// toute fiche déjà ARCHIVED/archivee (donc déjà avec archivedAt renseigné),
// donc un tick suivant ne la retraite jamais.
//
// `transaction` optionnel sur chaque fonction — utilisé UNIQUEMENT par les
// tests (isolation totale, jamais d'écriture réelle) ; le cron réel
// (ficheAutoValidation.job.js) appelle toujours sans transaction.
// ═══════════════════════════════════════════════════════════════════════

const { Op } = require("sequelize");
const PorPromesh = require("../../../models/PorPromesh");
const porPromeshRepo = require("../../por-promesh/repositories/porPromesh.repository");
const IndustrialRecord = require("../../../models/IndustrialRecord");
const ProductionDraftArchiveLog = require("../../../models/ProductionDraftArchiveLog");
const User = require("../../../models/User");
const Notification = require("../../../models/Notification");
const logger = require("../../../utils/logger");

// Délai calculé depuis createdAt (jamais updatedAt : modifier une fiche ne
// repousse pas l'échéance). Seuil inclus : createdAt <= now - 8h → archivée
// (7h59 → active, 8h00 → archivable). Ancienne valeur : 2h.
const DRAFT_ARCHIVE_DELAY_HOURS = 8;
const DRAFT_ARCHIVE_DELAY_MS = DRAFT_ARCHIVE_DELAY_HOURS * 60 * 60 * 1000;
const REASON = `Automatically archived after ${DRAFT_ARCHIVE_DELAY_HOURS} hours in draft.`;
const ARCHIVED_BY_SYSTEM = "SYSTEM";

function isDraftArchiveEnabled() {
  return process.env.PRODUCTION_DRAFT_ARCHIVE_ENABLED !== "false";
}

// Contrairement à AUTO_VALIDATION_CUTOFF_AT (qui verrouille définitivement),
// l'archivage est réversible (désarchivage) — pas de date de bascule par
// défaut : couvre aussi les brouillons déjà présents en base avant
// l'introduction de cette règle. Overridable via .env si nécessaire.
function draftArchiveCutoffAt() {
  const raw = process.env.PRODUCTION_DRAFT_ARCHIVE_CUTOFF_AT;
  const parsed = raw ? new Date(raw) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

async function notifyOwner(userId, email, message, transaction) {
  try {
    await Notification.create({ userId, type: "production_draft_archived", title: "Fiche archivée automatiquement", message: message.slice(0, 500) }, { transaction });
  } catch (err) {
    logger.error(`[production-draft-archive] notification échouée pour ${email}: ${err.message}`);
  }
}

async function logArchive({ ficheType, ficheId, userId, userEmail, dateProduction, machine, poste, ficheCreatedAt, expiresAt, archivedAt }, transaction) {
  return ProductionDraftArchiveLog.create(
    { ficheType, ficheId, userId, userEmail, dateProduction: dateProduction || null, machine: machine || null, poste: poste || null, ficheCreatedAt, expiresAt, archivedAt, reason: REASON, action: "AUTO_ARCHIVED" },
    { transaction }
  );
}

function draftWherePromesh(cutoff) {
  const where = { status: "BROUILLON" };
  if (cutoff) where.createdAt = { [Op.gte]: cutoff };
  return where;
}

// Une fiche désarchivée (demande APPROUVÉE) retrouve un délai de brouillon
// complet (DRAFT_ARCHIVE_DELAY_MS) à compter de son désarchivage — sans ça,
// son createdAt d'origine (> délai) la faisait ré-archiver au tick suivant du
// cron (≤ 5 min), rendant l'approbation inutilisable. Même règle du délai,
// simplement comptée depuis max(createdAt, unarchivedAt).
function notRecentlyUnarchived(now) {
  return { [Op.or]: [{ unarchivedAt: null }, { unarchivedAt: { [Op.lte]: new Date(now.getTime() - DRAFT_ARCHIVE_DELAY_MS) } }] };
}

function draftClockStart(fiche) {
  const created = new Date(fiche.createdAt).getTime();
  const unarchived = fiche.unarchivedAt ? new Date(fiche.unarchivedAt).getTime() : 0;
  return new Date(Math.max(created, unarchived));
}

function expiredWherePromesh(now, cutoff) {
  const where = { status: "BROUILLON", createdAt: { [Op.lte]: new Date(now.getTime() - DRAFT_ARCHIVE_DELAY_MS) }, ...notRecentlyUnarchived(now) };
  if (cutoff) where.createdAt[Op.gte] = cutoff;
  return where;
}

function draftWhereProbar(cutoff) {
  const where = { module: "probar", statut: "enregistree" };
  if (cutoff) where.createdAt = { [Op.gte]: cutoff };
  return where;
}

function expiredWhereProbar(now, cutoff) {
  const where = { module: "probar", statut: "enregistree", createdAt: { [Op.lte]: new Date(now.getTime() - DRAFT_ARCHIVE_DELAY_MS) }, ...notRecentlyUnarchived(now) };
  if (cutoff) where.createdAt[Op.gte] = cutoff;
  return where;
}

/**
 * Compte total (drafts=X) + total expiré (expired=Y) sur les DEUX modules —
 * calculé AVANT tout archivage pour le log CHECK (§8), séquentiel si une
 * transaction est fournie (un seul client pg à la fois, même contrainte que
 * compliance.service.computeDays), parallèle sinon.
 */
async function countDraftsAndExpired(now, transaction) {
  const cutoff = draftArchiveCutoffAt();
  if (transaction) {
    const drafts =
      (await PorPromesh.count({ where: draftWherePromesh(cutoff), transaction })) +
      (await IndustrialRecord.count({ where: draftWhereProbar(cutoff), transaction }));
    const expired =
      (await PorPromesh.count({ where: expiredWherePromesh(now, cutoff), transaction })) +
      (await IndustrialRecord.count({ where: expiredWhereProbar(now, cutoff), transaction }));
    return { drafts, expired };
  }
  const [dp, db_, ep, eb] = await Promise.all([
    PorPromesh.count({ where: draftWherePromesh(cutoff) }),
    IndustrialRecord.count({ where: draftWhereProbar(cutoff) }),
    PorPromesh.count({ where: expiredWherePromesh(now, cutoff) }),
    IndustrialRecord.count({ where: expiredWhereProbar(now, cutoff) }),
  ]);
  return { drafts: dp + db_, expired: ep + eb };
}

/** PROMESH — archive TOUTE fiche BROUILLON créée il y a 8h ou plus (aucune exception de complétude). */
async function sweepDraftArchivePromesh(now = new Date(), transaction) {
  if (!isDraftArchiveEnabled()) return { checked: 0, archived: 0 };

  const cutoff = draftArchiveCutoffAt();
  const candidates = await porPromeshRepo.findAll(expiredWherePromesh(now, cutoff), { light: true, limit: 5000, transaction });
  let archived = 0;
  const owners = new Map();
  for (const report of candidates) {
    const ficheCreatedAt = new Date(report.createdAt);
    const expiresAt = new Date(draftClockStart(report).getTime() + DRAFT_ARCHIVE_DELAY_MS);
    logger.info(`[PRODUCTION-DRAFT-ARCHIVE]\nARCHIVING\nmodule=PROMESH\nid=${report.id}\ncreatedAt=${ficheCreatedAt.toISOString()}\nexpiresAt=${expiresAt.toISOString()}\nstatus=draft`);

    // UPDATE conditionnel (§13) : n'archive que si la fiche est TOUJOURS
    // BROUILLON à cet instant précis — protège contre un archivage en
    // double si plusieurs instances backend exécutent le sweep en même temps.
    // Renseigne aussi archivedAt/archivedBy/archiveReason DIRECTEMENT sur la
    // fiche (en plus du journal d'audit ci-dessous) — exigence explicite de
    // ce ticket, pour un affichage/requête direct sans jointure.
    const [affected] = await PorPromesh.update(
      { status: "ARCHIVED", archivedAt: now, archivedBy: ARCHIVED_BY_SYSTEM, archiveReason: REASON },
      { where: { id: report.id, status: "BROUILLON" }, transaction }
    );
    if (affected === 0) continue; // déjà traitée par une autre exécution concurrente

    let owner = owners.get(report.createdBy);
    if (owner === undefined) {
      owner = await User.findByPk(report.createdBy, { attributes: ["id", "email"], transaction });
      owners.set(report.createdBy, owner || null);
    }
    await logArchive(
      { ficheType: "PROMESH", ficheId: report.id, userId: report.createdBy, userEmail: owner?.email || "-", dateProduction: report.dateProduction, machine: report.machine, poste: report.poste, ficheCreatedAt, expiresAt, archivedAt: now },
      transaction
    );
    if (owner) {
      await notifyOwner(
        owner.id,
        owner.email,
        `Votre fiche de production PROMESH du ${report.dateProduction || "-"} a été archivée automatiquement car elle est restée en brouillon pendant plus de ${DRAFT_ARCHIVE_DELAY_HOURS} heures. Vous pouvez demander son désarchivage.`,
        transaction
      );
    }
    logger.info(`[PRODUCTION-DRAFT-ARCHIVE]\nARCHIVED SUCCESSFULLY\nmodule=PROMESH\nid=${report.id}`);
    archived += 1;
  }
  return { checked: candidates.length, archived };
}

/** PROBAR — même règle, colonnes industrial_records (statut string, pas d'isLocked). */
async function sweepDraftArchiveProbar(now = new Date(), transaction) {
  if (!isDraftArchiveEnabled()) return { checked: 0, archived: 0 };

  const cutoff = draftArchiveCutoffAt();
  const candidates = await IndustrialRecord.findAll({ where: expiredWhereProbar(now, cutoff), transaction });
  let archived = 0;
  const owners = new Map();
  for (const record of candidates) {
    const ficheCreatedAt = new Date(record.createdAt);
    const expiresAt = new Date(draftClockStart(record).getTime() + DRAFT_ARCHIVE_DELAY_MS);
    logger.info(`[PRODUCTION-DRAFT-ARCHIVE]\nARCHIVING\nmodule=PROBAR\nid=${record.id}\ncreatedAt=${ficheCreatedAt.toISOString()}\nexpiresAt=${expiresAt.toISOString()}\nstatus=draft`);

    // Même UPDATE conditionnel + mêmes 3 champs directs que PROMESH (§13, §7).
    const [affected] = await IndustrialRecord.update(
      { statut: "archivee", archivedAt: now, archivedBy: ARCHIVED_BY_SYSTEM, archiveReason: REASON },
      { where: { id: record.id, statut: "enregistree" }, transaction }
    );
    if (affected === 0) continue;

    let owner = owners.get(record.createdBy);
    if (owner === undefined) {
      owner = await User.findByPk(record.createdBy, { attributes: ["id", "email"], transaction });
      owners.set(record.createdBy, owner || null);
    }
    await logArchive(
      { ficheType: "PROBAR", ficheId: record.id, userId: record.createdBy, userEmail: owner?.email || "-", dateProduction: record.dateFiche, machine: record.machine, poste: record.poste, ficheCreatedAt, expiresAt, archivedAt: now },
      transaction
    );
    if (owner) {
      await notifyOwner(
        owner.id,
        owner.email,
        `Votre fiche de production PROBAR du ${record.dateFiche || "-"} a été archivée automatiquement car elle est restée en brouillon pendant plus de ${DRAFT_ARCHIVE_DELAY_HOURS} heures. Vous pouvez demander son désarchivage.`,
        transaction
      );
    }
    logger.info(`[PRODUCTION-DRAFT-ARCHIVE]\nARCHIVED SUCCESSFULLY\nmodule=PROBAR\nid=${record.id}`);
    archived += 1;
  }
  return { checked: candidates.length, archived };
}

/**
 * Appelé par le cron (§1) — idempotent (§13) : une fiche déjà ARCHIVED/
 * archivee (donc avec archivedAt déjà renseigné) est exclue dès le WHERE, et
 * l'UPDATE conditionnel protège contre un archivage en double par deux
 * instances backend concurrentes.
 *
 * Log "CHECK" (§8, nouveau format) : imprimé À CHAQUE appel, même quand il
 * n'y a rien à archiver — c'est la preuve visuelle que le scheduler tourne
 * réellement toutes les 5 minutes, indépendamment de Flutter/WebSocket/HTTP.
 */
async function sweepDraftArchive(now = new Date(), transaction) {
  if (!isDraftArchiveEnabled()) {
    logger.info(`[PRODUCTION-DRAFT-ARCHIVE]\nCHECK\nnow=${now.toISOString()}\ndrafts=0\nexpired=0`);
    return { promesh: { checked: 0, archived: 0 }, probar: { checked: 0, archived: 0 } };
  }

  const { drafts, expired } = await countDraftsAndExpired(now, transaction);
  logger.info(`[PRODUCTION-DRAFT-ARCHIVE]\nCHECK\nnow=${now.toISOString()}\ndrafts=${drafts}\nexpired=${expired}`);

  // Séquentiel si transaction fournie (un client pg ne traite qu'une requête
  // à la fois, même règle que compliance.service.computeDays) ; parallèle sinon.
  const [promesh, probar] = transaction
    ? [await sweepDraftArchivePromesh(now, transaction), await sweepDraftArchiveProbar(now, transaction)]
    : await Promise.all([sweepDraftArchivePromesh(now), sweepDraftArchiveProbar(now)]);
  return { promesh, probar };
}

/**
 * Liste directe des fiches ACTUELLEMENT archivées (§12 — distinct des
 * "Unarchive requests", qui ne montrent que les DEMANDES de désarchivage,
 * pas les fiches elles-mêmes ; une fiche archivée peut très bien n'avoir
 * aucune demande en cours). Lit directement archivedAt/archivedBy/
 * archiveReason posés sur la fiche (ce ticket) — jamais une jointure sur le
 * journal d'audit, qui reste un historique complet (cycles multiples),
 * alors que ceci reflète l'état ACTUEL.
 */
async function listArchivedSheets({ ficheType } = {}) {
  const [promeshRows, probarRows] = await Promise.all([
    ficheType && ficheType !== "PROMESH"
      ? []
      : PorPromesh.findAll({ where: { status: "ARCHIVED" }, order: [["archivedAt", "DESC"]], limit: 500, include: [{ model: User, as: "creator", attributes: ["id", "email"] }] }),
    ficheType && ficheType !== "PROBAR"
      ? []
      : IndustrialRecord.findAll({ where: { module: "probar", statut: "archivee" }, order: [["archivedAt", "DESC"]], limit: 500, include: [{ model: User, as: "creator", attributes: ["id", "email"] }] }),
  ]);

  const promesh = promeshRows.map((f) => ({
    ficheType: "PROMESH",
    id: f.id,
    numero: `PROMESH-${new Date(f.createdAt).getFullYear()}-${String(f.sequenceNumber).padStart(6, "0")}`,
    machine: f.machine,
    poste: f.poste,
    dateProduction: f.dateProduction,
    userEmail: f.creator?.email || null,
    createdAt: f.createdAt,
    archivedAt: f.archivedAt,
    archivedBy: f.archivedBy,
    archiveReason: f.archiveReason,
  }));
  const probar = probarRows.map((r) => ({
    ficheType: "PROBAR",
    id: r.id,
    numero: null,
    machine: r.machine,
    poste: r.poste,
    dateProduction: r.dateFiche,
    userEmail: r.creator?.email || null,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt,
    archivedBy: r.archivedBy,
    archiveReason: r.archiveReason,
  }));

  return [...promesh, ...probar].sort((a, b) => new Date(b.archivedAt || 0) - new Date(a.archivedAt || 0));
}

module.exports = {
  DRAFT_ARCHIVE_DELAY_HOURS,
  DRAFT_ARCHIVE_DELAY_MS,
  REASON,
  ARCHIVED_BY_SYSTEM,
  isDraftArchiveEnabled,
  draftArchiveCutoffAt,
  sweepDraftArchivePromesh,
  sweepDraftArchiveProbar,
  sweepDraftArchive,
  listArchivedSheets,
};
