"use strict";

// "Production — Statistiques des demandes" + historique des demandes.
//
// AUCUNE table de demandes dupliquée : tout est lu depuis les tables
// existantes, à chaque appel (jamais de valeur statique) :
//   - production_compliance_authorization_requests  → demandes d'AUTORISATION
//     (statut AFFICHÉ recalculé par compliance.viewRequests : EXPIRED /
//     PARTIALLY_USED dynamiques, comme l'écran Production Compliance) ;
//   - production_unarchive_requests                 → demandes de DÉSARCHIVAGE ;
//   - production_draft_archive_log                  → ARCHIVAGES automatiques
//     (événements, pas des demandes : aucun statut, jamais comptés dans
//     total/approuvées/refusées/en attente) ;
//   - production_request_audit_log / email_queue    → traçabilité.

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { Op } = require("sequelize");

dayjs.extend(utc);
dayjs.extend(timezone);

const AuthRequest = require("../../../models/ProductionComplianceAuthorizationRequest");
const Authorization = require("../../../models/ProductionComplianceAuthorization");
const UnarchiveRequest = require("../../../models/ProductionUnarchiveRequest");
const ArchiveLog = require("../../../models/ProductionDraftArchiveLog");
const ProductionRequestAudit = require("../../../models/ProductionRequestAudit");
const EmailQueue = require("../../../models/EmailQueue");
const User = require("../../../models/User");
const compliance = require("../../production-compliance/services/compliance.service");
const { CONTEXT: MAIL_CONTEXT } = require("./notify.service");

const TZ = "Africa/Tunis";
const TYPES = ["AUTHORIZATION", "UNARCHIVE", "ARCHIVE"];
const STATUSES = ["PENDING", "APPROVED", "REJECTED", "USED", "EXPIRED"];
const TYPE_LABELS = {
  AUTHORIZATION: "Autorisation de backfill",
  UNARCHIVE: "Désarchivage",
  ARCHIVE: "Archivage automatique",
};

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const tz = (d) => dayjs(d).tz(TZ);
const shortUser = (email) => (email ? String(email).split("@")[0] : null);

// PARTIALLY_USED = approuvée, en cours d'utilisation → comptée "approuvée".
function statusGroup(status) {
  if (status === "PENDING") return "pending";
  if (status === "REJECTED") return "rejected";
  if (status === "EXPIRED") return "expired";
  if (["APPROVED", "USED", "PARTIALLY_USED"].includes(status)) return "approved";
  return null;
}

function matchesStatus(itemStatus, wanted) {
  if (!wanted) return true;
  if (wanted === "APPROVED") return itemStatus === "APPROVED" || itemStatus === "PARTIALLY_USED";
  return itemStatus === wanted;
}

// ── Filtres ──────────────────────────────────────────────────────────────

function parseDay(value, name) {
  if (!value) return null;
  const d = dayjs.tz(String(value), "YYYY-MM-DD", TZ);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !d.isValid()) {
    throw new AppError(400, "INVALID_DATE", `${name} doit être au format AAAA-MM-JJ`);
  }
  return d;
}

function parseFilters(q = {}) {
  const from = parseDay(q.from, "from");
  const to = parseDay(q.to, "to");
  const production = q.production ? String(q.production).toUpperCase() : null;
  if (production && !compliance.cfg.productions[production]) throw new AppError(400, "INVALID_PRODUCTION", "Production inconnue (PROD1 ou PROD2)");
  const type = q.type ? String(q.type).toUpperCase() : null;
  if (type && !TYPES.includes(type)) throw new AppError(400, "INVALID_TYPE", `Type inconnu (${TYPES.join(", ")})`);
  const status = q.status ? String(q.status).toUpperCase() : null;
  if (status && !STATUSES.includes(status)) throw new AppError(400, "INVALID_STATUS", `Statut inconnu (${STATUSES.join(", ")})`);
  const granularity = ["day", "week", "month"].includes(q.granularity) ? q.granularity : "day";
  const userId = q.userId && /^[0-9a-f-]{36}$/i.test(String(q.userId)) ? String(q.userId) : null;
  return {
    from,
    to,
    production,
    userId,
    type,
    status,
    granularity,
    // Filtre période appliqué sur la date de demande (ou d'archivage), en
    // jours de Tunis : [from 00:00, to+1 00:00[.
    range: from || to ? { ...(from ? { [Op.gte]: from.toDate() } : {}), ...(to ? { [Op.lt]: to.add(1, "day").toDate() } : {}) } : null,
  };
}

// ── Lecture unifiée ──────────────────────────────────────────────────────

async function loadItems(f) {
  const prodEmail = f.production ? compliance.cfg.productions[f.production].email : null;
  const want = (t) => !f.type || f.type === t;
  const items = [];

  if (want("AUTHORIZATION")) {
    const where = {};
    if (f.range) where.requestedAt = f.range;
    if (f.userId) where.userId = f.userId;
    if (f.production) where.productionType = f.production;
    const rows = await AuthRequest.findAll({ where, order: [["requestedAt", "DESC"]] });
    const views = await compliance.viewRequests(rows);
    views.forEach((v, i) => {
      const r = rows[i];
      items.push({
        type: "AUTHORIZATION",
        id: v.id,
        userId: r.userId,
        userEmail: r.userEmail,
        productionKey: r.productionType,
        at: r.requestedAt,
        status: v.status,
        reason: r.reason,
        concernedDates: v.missingDates || [r.missingDate],
        reviewerEmail: r.reviewerEmail,
        reviewedAt: r.reviewedAt,
        reviewNote: r.reviewNote,
        expiresAt: r.expiresAt,
        ficheType: null,
      });
    });
  }

  if (want("UNARCHIVE")) {
    const where = {};
    if (f.range) where.requestedAt = f.range;
    if (f.userId) where.userId = f.userId;
    if (prodEmail) where.userEmail = prodEmail;
    const rows = await UnarchiveRequest.findAll({ where, order: [["requestedAt", "DESC"]] });
    for (const r of rows) {
      items.push({
        type: "UNARCHIVE",
        id: r.id,
        userId: r.userId,
        userEmail: r.userEmail,
        productionKey: compliance.getMonitoredByEmail(r.userEmail)?.key || null,
        at: r.requestedAt,
        status: r.status,
        reason: r.reason,
        concernedDates: r.dateProduction ? [r.dateProduction] : [],
        reviewerEmail: r.reviewerEmail,
        reviewedAt: r.reviewedAt,
        reviewNote: r.reviewNote,
        expiresAt: null,
        ficheType: r.ficheType,
      });
    }
  }

  // Les archivages automatiques n'ont pas de statut : exclus dès qu'un
  // filtre de statut est demandé.
  if (want("ARCHIVE") && !f.status) {
    const where = {};
    if (f.range) where.archivedAt = f.range;
    if (f.userId) where.userId = f.userId;
    if (prodEmail) where.userEmail = prodEmail;
    const rows = await ArchiveLog.findAll({ where, order: [["archivedAt", "DESC"]] });
    for (const r of rows) {
      items.push({
        type: "ARCHIVE",
        id: r.id,
        userId: r.userId,
        userEmail: r.userEmail,
        productionKey: compliance.getMonitoredByEmail(r.userEmail)?.key || null,
        at: r.archivedAt,
        status: r.unarchivedAt ? "UNARCHIVED" : "ARCHIVED",
        reason: r.reason,
        concernedDates: r.dateProduction ? [r.dateProduction] : [],
        reviewerEmail: r.unarchivedByEmail,
        reviewedAt: r.unarchivedAt,
        reviewNote: null,
        expiresAt: null,
        ficheType: r.ficheType,
      });
    }
  }

  return items.filter((i) => i.type === "ARCHIVE" || matchesStatus(i.status, f.status));
}

// ── Statistiques ─────────────────────────────────────────────────────────

function emptyCounters() {
  return { archiveEvents: 0, unarchiveRequests: 0, authorizationRequests: 0, total: 0, approved: 0, rejected: 0, pending: 0, expired: 0 };
}

function count(counters, item) {
  if (item.type === "ARCHIVE") {
    counters.archiveEvents += 1;
    return;
  }
  if (item.type === "UNARCHIVE") counters.unarchiveRequests += 1;
  else counters.authorizationRequests += 1;
  counters.total += 1;
  const g = statusGroup(item.status);
  if (g) counters[g] += 1;
}

function bucketKey(date, granularity) {
  const d = tz(date);
  if (granularity === "month") return d.format("YYYY-MM");
  if (granularity === "week") return d.subtract((d.day() + 6) % 7, "day").format("YYYY-MM-DD");
  return d.format("YYYY-MM-DD");
}

function bucketLabel(key, granularity) {
  if (granularity === "month") return dayjs(`${key}-01`).format("MM/YYYY");
  if (granularity === "week") return `S. ${dayjs(key).format("DD/MM")}`;
  return dayjs(key).format("DD/MM");
}

function buildTimeline(items, granularity) {
  const buckets = new Map();
  for (const i of items) {
    const key = bucketKey(i.at, granularity);
    if (!buckets.has(key)) buckets.set(key, { authorization: 0, unarchive: 0, archive: 0 });
    buckets.get(key)[i.type === "AUTHORIZATION" ? "authorization" : i.type === "UNARCHIVE" ? "unarchive" : "archive"] += 1;
  }
  const keys = [...buckets.keys()].sort();
  if (!keys.length) return [];
  // Périodes vides comblées entre la première et la dernière (courbe continue).
  const unit = granularity === "month" ? "month" : granularity === "week" ? "week" : "day";
  const all = [];
  let cursor = dayjs(granularity === "month" ? `${keys[0]}-01` : keys[0]);
  const last = dayjs(granularity === "month" ? `${keys[keys.length - 1]}-01` : keys[keys.length - 1]);
  while (!cursor.isAfter(last) && all.length < 400) {
    all.push(granularity === "month" ? cursor.format("YYYY-MM") : cursor.format("YYYY-MM-DD"));
    cursor = cursor.add(1, unit);
  }
  return all.map((key) => {
    const b = buckets.get(key) || { authorization: 0, unarchive: 0, archive: 0 };
    return { period: key, label: bucketLabel(key, granularity), ...b, total: b.authorization + b.unarchive };
  });
}

function productionLabel(key) {
  return key ? compliance.cfg.productions[key]?.label || key : null;
}

async function productionUsers() {
  const prods = Object.values(compliance.cfg.productions);
  const users = await User.findAll({ where: { email: prods.map((p) => p.email) }, attributes: ["id", "email"] });
  return prods.map((p) => ({ key: p.key, label: p.label, email: p.email, userId: users.find((u) => u.email === p.email)?.id || null }));
}

async function getStatistics(query) {
  const f = parseFilters(query);
  const items = await loadItems(f);

  // Utilisateurs PROD 1 / PROD 2 toujours listés (même à 0), filtrés comme
  // les demandes ; + tout autre demandeur rencontré dans les données.
  const prodUsers = await productionUsers();
  const byUser = new Map();
  for (const p of prodUsers) {
    if (f.production && f.production !== p.key) continue;
    if (f.userId && f.userId !== p.userId) continue;
    byUser.set(p.email, { userId: p.userId, userEmail: p.email, production: p.key, ...emptyCounters() });
  }
  for (const i of items) {
    if (!byUser.has(i.userEmail)) {
      byUser.set(i.userEmail, { userId: i.userId, userEmail: i.userEmail, production: i.productionKey, ...emptyCounters() });
    }
    count(byUser.get(i.userEmail), i);
  }

  const kpis = emptyCounters();
  for (const i of items) count(kpis, i);

  const users = [...byUser.values()]
    .map((u) => ({ ...u, userLabel: shortUser(u.userEmail), productionLabel: productionLabel(u.production) }))
    .sort((a, b) => b.total - a.total || String(a.userEmail).localeCompare(String(b.userEmail)));

  return {
    filters: {
      from: f.from?.format("YYYY-MM-DD") || null,
      to: f.to?.format("YYYY-MM-DD") || null,
      production: f.production,
      userId: f.userId,
      type: f.type,
      status: f.status,
      granularity: f.granularity,
    },
    kpis,
    users,
    timeline: buildTimeline(items, f.granularity),
    options: {
      productions: prodUsers.map((p) => ({ key: p.key, label: p.label })),
      users: prodUsers.filter((p) => p.userId).map((p) => ({ id: p.userId, email: p.email, label: shortUser(p.email) })),
      types: TYPES.map((t) => ({ key: t, label: TYPE_LABELS[t] })),
      statuses: STATUSES,
    },
  };
}

// ── Historique ───────────────────────────────────────────────────────────

function toHistoryRow(i) {
  const at = tz(i.at);
  return {
    type: i.type,
    typeLabel: TYPE_LABELS[i.type],
    id: i.id,
    date: at.format("DD/MM/YYYY"),
    time: at.format("HH:mm"),
    at: i.at,
    userId: i.userId,
    userEmail: i.userEmail,
    userLabel: shortUser(i.userEmail),
    production: i.productionKey,
    productionLabel: productionLabel(i.productionKey),
    ficheType: i.ficheType,
    concernedDates: i.concernedDates,
    reason: i.reason,
    status: i.status,
    reviewerEmail: i.reviewerEmail,
    reviewedAt: i.reviewedAt,
    reviewedDate: i.reviewedAt ? tz(i.reviewedAt).format("DD/MM/YYYY HH:mm") : null,
    reviewNote: i.reviewNote,
    expiresAt: i.expiresAt,
  };
}

async function getHistory(query) {
  const f = parseFilters(query);
  const items = await loadItems(f);
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  const limit = Math.max(1, Math.min(1000, parseInt(query.limit, 10) || 500));
  return items.slice(0, limit).map(toHistoryRow);
}

function event(at, code, label, fields = {}) {
  const d = tz(at);
  return { at, date: d.format("DD/MM/YYYY"), time: d.format("HH:mm:ss"), code, label, ...fields };
}

function auditView(a) {
  const d = tz(a.createdAt);
  return {
    id: a.id,
    action: a.action,
    outcome: a.outcome,
    httpStatus: a.httpStatus,
    userId: a.userId,
    userEmail: a.userEmail,
    oldValue: a.oldValue,
    newValue: a.newValue,
    details: a.details,
    createdAt: a.createdAt,
    date: d.format("DD/MM/YYYY"),
    time: d.format("HH:mm:ss"),
  };
}

// Historique complet d'UNE demande : cycle de vie + journal d'audit + emails.
async function getRequestHistory(type, id) {
  const requestType = String(type || "").toUpperCase();
  if (!["AUTHORIZATION", "UNARCHIVE"].includes(requestType)) throw new AppError(400, "INVALID_TYPE", "Type de demande invalide");
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) throw new AppError(404, "NOT_FOUND", "Demande introuvable");

  const timeline = [];
  let request;
  let usage = [];

  if (requestType === "AUTHORIZATION") {
    const row = await AuthRequest.findByPk(id);
    if (!row) throw new AppError(404, "NOT_FOUND", "Demande introuvable");
    const [view] = await compliance.viewRequests([row]);
    request = toHistoryRow({
      type: "AUTHORIZATION",
      id: row.id,
      userId: row.userId,
      userEmail: row.userEmail,
      productionKey: row.productionType,
      at: row.requestedAt,
      status: view.status,
      reason: row.reason,
      concernedDates: view.missingDates || [row.missingDate],
      reviewerEmail: row.reviewerEmail,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      expiresAt: row.expiresAt,
    });
    timeline.push(event(row.requestedAt, "CREATED", "Demande créée", { actorEmail: row.userEmail, newValue: "PENDING" }));
    if (row.reviewedAt) {
      timeline.push(event(row.reviewedAt, row.status === "REJECTED" ? "REJECTED" : "APPROVED", row.status === "REJECTED" ? "Demande refusée" : "Demande autorisée", {
        actorEmail: row.reviewerEmail,
        oldValue: "PENDING",
        newValue: row.status === "REJECTED" ? "REJECTED" : "APPROVED",
        note: row.reviewNote,
      }));
    }
    const authIds = (Array.isArray(row.createdAuthorizationIds) && row.createdAuthorizationIds.length ? row.createdAuthorizationIds : [row.createdAuthorizationId]).filter(Boolean);
    const auths = authIds.length ? await Authorization.findAll({ where: { id: authIds } }) : [];
    for (const a of auths.filter((x) => x.usedAt)) {
      timeline.push(
        event(a.usedAt, "USED", `Fiche du ${compliance.frDate(a.productionDate)} régularisée (${a.usedFicheType || "fiche"})`, {
          actorEmail: a.usedByEmail || row.userEmail,
          approvedByEmail: a.authorizedByEmail,
          ficheType: a.usedFicheType,
          ficheId: a.usedFicheId,
        })
      );
    }
    usage = auths.map((a) => ({
      date: a.productionDate,
      approvedByEmail: a.authorizedByEmail,
      approvedAt: a.authorizedAt,
      expiresAt: a.expiresAt,
      usedAt: a.usedAt,
      usedByEmail: a.usedByEmail || (a.usedAt ? row.userEmail : null),
      ficheType: a.usedFicheType,
      ficheId: a.usedFicheId,
    }));
    if (view.status === "EXPIRED" && row.expiresAt) {
      timeline.push(event(row.expiresAt, "EXPIRED", "Demande expirée", { newValue: "EXPIRED" }));
    }
  } else {
    const row = await UnarchiveRequest.findByPk(id);
    if (!row) throw new AppError(404, "NOT_FOUND", "Demande introuvable");
    request = toHistoryRow({
      type: "UNARCHIVE",
      id: row.id,
      userId: row.userId,
      userEmail: row.userEmail,
      productionKey: compliance.getMonitoredByEmail(row.userEmail)?.key || null,
      at: row.requestedAt,
      status: row.status,
      reason: row.reason,
      concernedDates: row.dateProduction ? [row.dateProduction] : [],
      reviewerEmail: row.reviewerEmail,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      ficheType: row.ficheType,
    });
    timeline.push(event(row.archivedAt, "ARCHIVED", `Fiche ${row.ficheType} archivée automatiquement`));
    timeline.push(event(row.requestedAt, "CREATED", "Demande de désarchivage créée", { actorEmail: row.userEmail, newValue: "PENDING" }));
    if (row.reviewedAt) {
      timeline.push(event(row.reviewedAt, row.status, row.status === "APPROVED" ? "Désarchivage approuvé" : "Désarchivage refusé", {
        actorEmail: row.reviewerEmail,
        oldValue: "PENDING",
        newValue: row.status,
        note: row.reviewNote,
      }));
    }
  }

  const [audit, emails] = await Promise.all([
    ProductionRequestAudit.findAll({ where: { requestType, requestId: id }, order: [["createdAt", "ASC"]] }),
    EmailQueue.findAll({
      where: { context: MAIL_CONTEXT, dedupeKey: { [Op.like]: `${MAIL_CONTEXT}:${requestType === "AUTHORIZATION" ? "authorization" : "unarchive"}:${id}:%` } },
      attributes: ["to", "subject", "status", "attempts", "sentAt", "createdAt", "lastErrorMessage"],
      order: [["createdAt", "ASC"]],
    }),
  ]);

  timeline.sort((a, b) => new Date(a.at) - new Date(b.at));
  return {
    request,
    timeline,
    usage,
    audit: audit.map(auditView),
    emails: emails.map((e) => ({ to: e.to, subject: e.subject, status: e.status, attempts: e.attempts, sentAt: e.sentAt, error: e.lastErrorMessage })),
  };
}

async function listAudit(query) {
  const where = {};
  if (query.requestType) where.requestType = String(query.requestType).toUpperCase();
  if (query.requestId && /^[0-9a-f-]{36}$/i.test(query.requestId)) where.requestId = query.requestId;
  if (query.userId && /^[0-9a-f-]{36}$/i.test(query.userId)) where.userId = query.userId;
  const limit = Math.max(1, Math.min(500, parseInt(query.limit, 10) || 200));
  const rows = await ProductionRequestAudit.findAll({ where, order: [["createdAt", "DESC"]], limit });
  return rows.map(auditView);
}

async function recordView(actor, action, { requestType = null, requestId = null, details = null } = {}) {
  await ProductionRequestAudit.create({
    userId: actor.id,
    userEmail: actor.email,
    action,
    requestType,
    requestId,
    outcome: "SUCCESS",
    httpStatus: 200,
    details,
  });
}

module.exports = {
  AppError,
  TYPE_LABELS,
  getStatistics,
  getHistory,
  getRequestHistory,
  listAudit,
  recordView,
};
