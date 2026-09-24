"use strict";

// Demandes d'autorisation de régularisation (PROD 1 / PROD 2).
//
// Une demande couvre TOUTES les dates manquantes détectées au moment de la
// création (pas une seule) : createRequest ignore toute date envoyée par le
// client et recalcule missingDates côté serveur (jamais confiance dans
// Flutter) → PENDING, jamais d'auto-autorisation.
//   → un seul e-mail listant toutes les dates aux responsables (échec SMTP :
//     la demande reste PENDING, emailStatus FAILED, nouvel essai automatique)
//   responsable → approveRequest crée UNE autorisation BACKFILL_PREVIOUS_PRODUCTION
//     PAR date manquante (chacune limitée à sa date, à usage unique, avec
//     expiration) ou rejectRequest
//   création de chaque fiche manquante → son autorisation USED ; la demande ne
//     passe USED que lorsque TOUTES ses dates sont régularisées (voir
//     compliance.service.consumeAuthorization)

const { Op, UniqueConstraintError } = require("sequelize");

const { sequelize } = require("../../../db");
const Notification = require("../../../models/Notification");
const AuthRequest = require("../../../models/ProductionComplianceAuthorizationRequest");
const svc = require("./compliance.service");
const mail = require("./mail");
const logger = require("../../../utils/logger");
const Authorization = require("../../../models/ProductionComplianceAuthorization");

const { cfg, ComplianceError } = svc;

const STATUS_FR = {
  PENDING: "EN ATTENTE D'AUTORISATION",
  APPROVED: "AUTORISÉE",
  REJECTED: "REFUSÉE",
  EXPIRED: "EXPIRÉE",
  USED: "RÉGULARISATION EFFECTUÉE",
};

// ── Courrier ─────────────────────────────────────────────────────────────

function buildRequestEmail(r, prod) {
  const dates = (Array.isArray(r.missingDates) && r.missingDates.length ? r.missingDates : [r.missingDate]).map(svc.frDate);
  const current = svc.frDate(r.requestedDate);
  const link = `${cfg.crmBaseUrl}/production-compliance`;
  const reason = r.reason || "-";
  const subject = `[PROBAR CRM] Demande d'autorisation de rattrapage — ${prod.key}`;
  const text = [
    "Bonjour,",
    "",
    "Une demande d'autorisation de régularisation de production a été créée.",
    "",
    "Utilisateur :",
    r.userEmail,
    "",
    "Production :",
    prod.key,
    "",
    "Date demandée :",
    current,
    "",
    "Dates manquantes :",
    ...dates,
    "",
    "Motif :",
    reason,
    "",
    "Statut :",
    STATUS_FR.PENDING,
    "",
    "Merci de traiter cette demande depuis le CRM.",
    "",
    "Lien :",
    link,
  ].join("\n");
  const row = (k, v) => `<tr><td style="padding:4px 14px 4px 0;color:#555;vertical-align:top">${k}</td><td style="padding:4px 0"><b>${v}</b></td></tr>`;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<p>Bonjour,</p>
<p>Une demande d'autorisation de régularisation de production a été créée.</p>
<table>${row("Utilisateur", esc(r.userEmail))}${row("Production", prod.key)}${row("Date demandée", current)}${row("Dates manquantes", dates.join(", "))}${row("Motif", esc(reason))}${row("Statut", STATUS_FR.PENDING)}</table>
<p>Merci de traiter cette demande depuis le CRM.</p>
<p><a href="${link}">Ouvrir Production Compliance</a></p></div>`;
  return { subject, text, html };
}

/** Envoie l'e-mail de la demande ; ne perd JAMAIS la demande (statut FAILED + nouvel essai). */
async function sendRequestEmail(row, { now = svc.getNow(), transaction } = {}) {
  const prod = cfg.productions[row.productionType];
  const { subject, text, html } = buildRequestEmail(row, prod);
  const attempt = { lastEmailAttemptAt: now, retryCount: row.retryCount + 1 };
  // Debug §11 — adresse EXACTE réellement configurée (cfg.requestRecipients, pas de
  // substitution silencieuse) ; jamais de token/mot de passe dans ce log.
  logger.info(`[PRODUCTION-COMPLIANCE] Production compliance email recipients:\n${cfg.requestRecipients.map((e) => `- ${e}`).join("\n")}`);
  logger.info(`[PRODUCTION-AUTHORIZATION] Sending email... request=${row.id} to=${cfg.requestRecipients.join(", ")}`);
  try {
    await mail.send({ to: cfg.requestRecipients, subject, text, html });
    await row.update({ ...attempt, emailStatus: "SENT", emailSentAt: now, emailError: null }, { transaction });
    logger.info(`[PRODUCTION-AUTHORIZATION] Email sent successfully request=${row.id}`);
  } catch (err) {
    await row.update({ ...attempt, emailStatus: "FAILED", emailError: String(err?.message || err).slice(0, 1000) }, { transaction });
    logger.error(`[PRODUCTION-AUTHORIZATION] Email FAILED request=${row.id}: ${err?.stack || err?.message || err}`);
  }
  return row.emailStatus;
}

// ── Création par l'utilisateur ───────────────────────────────────────────
// missingDate/missingDates envoyées par le client ne sont JAMAIS prises telles
// quelles : les dates manquantes "day-gap" sont toujours recalculées côté
// serveur (svc.blockingDates). Le seul champ client optionnellement pris en
// compte est requestedDate (la date exacte du 403 BACKFILL_NOT_AUTHORIZED) —
// et même celui-ci est revérifié indépendamment via
// svc.isEligibleForBackfillRequest() avant d'être ajouté : un client ne peut
// donc jamais faire créer une demande pour une date qu'il invente ou qui n'a
// plus besoin de régularisation (déjà autorisée, avant cfg.startDate, ou >= today).

async function createRequest({ userId, email, reason, requestedDate, now = svc.getNow(), transaction }) {
  const prod = svc.getMonitoredByEmail(email);
  if (!prod || !cfg.enabled) {
    throw new ComplianceError(403, "NOT_MONITORED", "This account is not subject to production compliance.", "Ce compte n'est pas soumis au contrôle de production.");
  }
  if (!reason || !String(reason).trim()) {
    throw new ComplianceError(400, "REASON_REQUIRED", "A reason is required.", "Le motif est obligatoire.");
  }
  const today = svc.todayStr(now);
  const askedDate = svc.normalizeDate(requestedDate);

  const run = async (t) => {
    const dayGapDates = await svc.blockingDates(prod, userId, { now, transaction: t });
    let dates = dayGapDates;

    // Date exacte du 403 direct (POST/PUT sur une date passée déjà pourvue en
    // fiches) : n'est pas un "day-gap" au sens de blockingDates(), mais exige
    // elle aussi une autorisation depuis la révision de la règle absolue —
    // on l'ajoute UNIQUEMENT si elle est indépendamment revérifiée éligible.
    if (askedDate && !dates.includes(askedDate) && (await svc.isEligibleForBackfillRequest(userId, prod, askedDate, today, now, t))) {
      dates = [...dates, askedDate].sort();
    }

    // §8/§23 — une date qui a DÉJÀ une autorisation BACKFILL active (non consommée,
    // accordée via une demande APPROVED précédente ou directement par un
    // responsable) n'a besoin d'AUCUNE nouvelle demande : elle est déjà exploitable
    // telle quelle (POST /por-promesh l'acceptera directement). On ne demande donc
    // que les dates réellement sans autorisation active — jamais de doublon.
    const alreadyAuthorizedDates = [];
    const stillNeeded = [];
    for (const d of dates) {
      const auth = await svc.activeBackfillAuth(userId, prod, d, now, t);
      (auth ? alreadyAuthorizedDates : stillNeeded).push(d);
    }
    dates = stillNeeded;

    if (dates.length === 0) {
      if (alreadyAuthorizedDates.length > 0) {
        // "An authorization request already exists for this date." — on renvoie la
        // demande APPROVED la plus récente qui couvre ces dates, pour affichage.
        const covering = await AuthRequest.findOne({
          where: { userId, productionType: prod.key, status: "APPROVED" },
          order: [["requestedAt", "DESC"]],
          transaction: t,
        });
        if (covering) {
          const [view] = await svc.viewRequests([covering], now, t);
          return { request: view, alreadyPending: true, alreadyAuthorized: true };
        }
      }
      throw new ComplianceError(409, "NOT_MISSING", "No missing production sheet to regularize.", "Aucune fiche de production manquante à régulariser.");
    }

    const existing = await AuthRequest.findOne({ where: { userId, productionType: prod.key, status: "PENDING" }, transaction: t, lock: t.LOCK.UPDATE });
    if (existing && (!existing.expiresAt || new Date(existing.expiresAt) > now)) {
      // Demande déjà envoyée : on ne la duplique pas. Si `dates` (day-gap + askedDate
      // revérifié) contient une date que cette demande PENDING ne couvre pas encore
      // (ex. un 2e 403 direct, sur une autre date, pendant qu'une 1re demande est en
      // attente), on l'y ajoute plutôt que de la perdre silencieusement — sinon cette
      // date resterait bloquée jusqu'à la résolution de la demande existante.
      const existingDates = Array.isArray(existing.missingDates) && existing.missingDates.length ? existing.missingDates : [existing.missingDate];
      const merged = Array.from(new Set([...existingDates, ...dates])).sort();
      if (merged.length !== existingDates.length) {
        await existing.update({ missingDates: merged, missingDate: merged[0] }, { transaction: t });
      }
      if (existing.emailStatus !== "SENT" && existing.retryCount < cfg.maxEmailRetries) await sendRequestEmail(existing, { now, transaction: t });
      const [view] = await svc.viewRequests([existing], now, t);
      return { request: view, alreadyPending: true };
    }
    if (existing) await existing.update({ status: "EXPIRED" }, { transaction: t });

    let row;
    try {
      row = await AuthRequest.create(
        {
          userId,
          userEmail: prod.email,
          productionType: prod.key,
          missingDate: dates[0],
          missingDates: dates,
          // La date que l'utilisateur essayait réellement de créer quand il a été
          // bloqué (le 403 direct sur une date passée précise), sinon aujourd'hui
          // (cas "day-gap" : blocage de la création du jour par des dates manquantes).
          requestedDate: askedDate || today,
          authorizationType: svc.BACKFILL,
          reason: String(reason).trim().slice(0, 1000),
          status: "PENDING",
          requestedAt: now,
          expiresAt: new Date(now.getTime() + cfg.requestTtlHours * 3600 * 1000),
          emailStatus: "PENDING",
        },
        { transaction: t }
      );
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        const dup = await AuthRequest.findOne({ where: { userId, productionType: prod.key, status: "PENDING" }, transaction: t });
        const [view] = await svc.viewRequests([dup], now, t);
        return { request: view, alreadyPending: true };
      }
      throw err;
    }
    logger.info(`[PRODUCTION-AUTHORIZATION] Request created: ${row.id} user=${prod.email} production=${prod.key} missingDates=${dates.join(",")} requestedDate=${today}`);
    return { row };
  };

  const out = transaction ? await run(transaction) : await sequelize.transaction(run);
  if (out.request) return out; // demande déjà en attente : rien de plus à faire
  const { row } = out;

  const emailStatus = await sendRequestEmail(row, { now, transaction });
  const notified = await svc.notifyManagers(
    {
      type: "production_compliance_request",
      title: `Demande d'autorisation — ${prod.key} — ${row.missingDates.length} date(s)`,
      message: `${prod.email} demande la régularisation de ${row.missingDates.length} fiche(s) manquante(s) (${prod.key}) : ${row.missingDates.map(svc.frDate).join(", ")}. Motif : ${row.reason}`,
    },
    transaction
  );
  logger.info(
    `[PRODUCTION-AUTHORIZATION] REQUEST CREATED request=${row.id} user=${prod.email} dates=${row.missingDates.join(",")} requestedDate=${row.requestedDate} production=${prod.key} status=PENDING email=${emailStatus} crmNotified=${notified}`
  );
  const [view] = await svc.viewRequests([row], now, transaction);
  return { request: view, alreadyPending: false };
}

// ── Lecture ──────────────────────────────────────────────────────────────

async function listRequests({ status, production, userId, limit = 200 } = {}, { now = svc.getNow(), transaction } = {}) {
  const where = {};
  if (production) where.productionType = production;
  if (userId) where.userId = userId;
  const rows = await AuthRequest.findAll({ where, order: [["requestedAt", "DESC"]], limit: Math.min(Number(limit) || 200, 500), transaction });
  const views = await svc.viewRequests(rows, now, transaction);
  return status ? views.filter((v) => v.status === status) : views;
}

async function myRequests(userId, { now = svc.getNow(), transaction } = {}) {
  const rows = await AuthRequest.findAll({ where: { userId }, order: [["requestedAt", "DESC"]], limit: 50, transaction });
  return svc.viewRequests(rows, now, transaction);
}

/** Compteurs pour le tableau de bord responsable (PENDING/APPROVED/REJECTED/USED/EXPIRED). */
async function requestStats({ now = svc.getNow() } = {}) {
  const rows = await listRequests({}, { now });
  const stats = { PENDING: 0, APPROVED: 0, REJECTED: 0, USED: 0, EXPIRED: 0 };
  for (const r of rows) stats[r.status] = (stats[r.status] || 0) + 1;
  return stats;
}

// ── Décision du responsable ──────────────────────────────────────────────

async function loadPendingForUpdate(id, now, transaction) {
  const row = await AuthRequest.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!row) throw new ComplianceError(404, "NOT_FOUND", "Request not found.", "Demande introuvable.");
  if (row.status !== "PENDING") {
    throw new ComplianceError(409, "INVALID_STATE", `This request is already ${row.status}.`, `Cette demande est déjà ${STATUS_FR[row.status] || row.status}.`);
  }
  if (row.expiresAt && new Date(row.expiresAt) <= now) {
    await row.update({ status: "EXPIRED" }, { transaction });
    throw new ComplianceError(409, "REQUEST_EXPIRED", "This request has expired.", "Cette demande a expiré.");
  }
  return row;
}

/** Notifie l'utilisateur (CRM + e-mail) que ses dates ont été autorisées. */
async function notifyUserApproved(row, dates, manager, expiresAt, transaction) {
  const user = await svc.findUserByEmail(row.userEmail, transaction);
  if (!user) return;
  const datesFr = dates.map(svc.frDate);
  const title = "Rattrapage de fiches autorisé";
  const message = `Votre demande de régularisation PROD${row.productionType.replace("PROD", "")} a été approuvée. Dates autorisées : ${datesFr.join(", ")}.`;
  try {
    await Notification.create({ userId: user.id, type: "production_compliance_authorization", title, message: message.slice(0, 500) }, { transaction });
  } catch (err) {
    logger.error(`[PRODUCTION-AUTHORIZATION] user notification failed: ${err.message}`);
  }
  if (!cfg.userEmailNotifications) return;
  try {
    const expiry = expiresAt ? `\nCette autorisation expire le ${svc.tzNow(expiresAt).format("DD/MM/YYYY HH:mm")} (heure de Tunis).` : "";
    await mail.send({
      to: [row.userEmail],
      subject: `${title} — ${row.productionType}`,
      text: `${message}${expiry}\n\nVous pouvez maintenant saisir les fiches manquantes.\n\nAutorisé par : ${manager.email}\n\nCRM : ${cfg.crmBaseUrl}`,
      html: `<p>${message}</p>${expiry ? `<p>${expiry.trim()}</p>` : ""}<p>Vous pouvez maintenant saisir les fiches manquantes.</p><p>Autorisé par : ${manager.email}</p><p><a href="${cfg.crmBaseUrl}">Ouvrir le CRM</a></p>`,
    });
  } catch (err) {
    logger.error(`[PRODUCTION-AUTHORIZATION] user email failed: ${err.message}`);
  }
}

/** Crée UNE autorisation BACKFILL_PREVIOUS_PRODUCTION par date manquante de la demande. */
async function approveRequest({ managerId, id, note, now = svc.getNow(), externalTransaction }) {
  const run = async (transaction) => {
    const manager = await svc.assertManager(managerId, transaction);
    const row = await loadPendingForUpdate(id, now, transaction);
    const dates = Array.isArray(row.missingDates) && row.missingDates.length ? row.missingDates : [row.missingDate];
    const reasonBase = [`Demande ${row.id.slice(0, 8)}`, row.reason, note && `Note responsable : ${note}`].filter(Boolean).join(" — ");

    const authIds = [];
    let expiresAt = null;
    for (const d of dates) {
      // Une date déjà couverte par une autorisation active (accordée directement, hors
      // de cette demande) est réutilisée plutôt que de faire échouer toute l'approbation.
      const existingAuth = await Authorization.findOne({
        where: { userId: row.userId, productionType: row.productionType, productionDate: d, type: svc.BACKFILL, revokedAt: null, usedAt: null },
        transaction,
      });
      if (existingAuth && (!existingAuth.expiresAt || new Date(existingAuth.expiresAt) > now)) {
        authIds.push(existingAuth.id);
        expiresAt = existingAuth.expiresAt;
        continue;
      }
      const auth = await svc.createAuthorization({
        managerId,
        productionKey: row.productionType,
        date: d,
        type: svc.BACKFILL,
        reason: reasonBase,
        now,
        transaction,
        notify: false, // une seule notification groupée à la fin, voir notifyUserApproved
      });
      authIds.push(auth.id);
      expiresAt = auth.expiresAt;
    }

    await row.update(
      {
        status: "APPROVED",
        reviewedAt: now,
        reviewedBy: manager.id,
        reviewerEmail: manager.email,
        createdAuthorizationId: authIds[0],
        createdAuthorizationIds: authIds,
        expiresAt,
        reviewNote: note ? String(note).slice(0, 1000) : row.reviewNote,
      },
      { transaction }
    );
    return { row, manager, dates, authIds, expiresAt };
  };
  const { row, manager, dates, authIds, expiresAt } = externalTransaction ? await run(externalTransaction) : await sequelize.transaction(run);
  await notifyUserApproved(row, dates, manager, expiresAt, externalTransaction);
  logger.info(
    `[PRODUCTION-AUTHORIZATION] REQUEST APPROVED request=${row.id} approvedBy=${manager.email} user=${row.userEmail} production=${row.productionType} dates=${dates.join(",")} authorizations=${authIds.join(",")} expiresAt=${expiresAt?.toISOString?.() || expiresAt}`
  );
  const [view] = await svc.viewRequests([row], now, externalTransaction);
  return { request: view, authorizationIds: authIds };
}

async function rejectRequest({ managerId, id, note, now = svc.getNow(), externalTransaction }) {
  // Motif obligatoire (UI Administration > Production — Demandes d'autorisation) —
  // vérifié ici, jamais seulement côté Flutter, pour rester valable aussi via un
  // appel direct à l'API (Postman/curl).
  if (!note || !String(note).trim()) {
    throw new ComplianceError(400, "REASON_REQUIRED", "A reason is required to reject this request.", "Le motif est obligatoire pour refuser cette demande.");
  }
  const run = async (transaction) => {
    const manager = await svc.assertManager(managerId, transaction);
    const row = await loadPendingForUpdate(id, now, transaction);
    await row.update(
      { status: "REJECTED", reviewedAt: now, reviewedBy: manager.id, reviewerEmail: manager.email, reviewNote: note ? String(note).slice(0, 1000) : null },
      { transaction }
    );
    return { row, manager };
  };
  const { row, manager } = externalTransaction ? await run(externalTransaction) : await sequelize.transaction(run);
  const dates = (Array.isArray(row.missingDates) && row.missingDates.length ? row.missingDates : [row.missingDate]).map(svc.frDate);
  try {
    await Notification.create(
      {
        userId: row.userId,
        type: "production_compliance_request_rejected",
        title: "Demande de régularisation refusée",
        message: `Votre demande pour les fiches de production du ${dates.join(", ")} a été refusée.${note ? ` Motif : ${note}` : ""}`.slice(0, 500),
      },
      externalTransaction ? { transaction: externalTransaction } : undefined
    );
  } catch (err) {
    logger.error(`[PRODUCTION-AUTHORIZATION] rejection notification failed: ${err.message}`);
  }
  logger.info(`[PRODUCTION-AUTHORIZATION] REQUEST REJECTED request=${row.id} rejectedBy=${manager.email} user=${row.userEmail} production=${row.productionType} dates=${dates.join(",")}`);
  const [view] = await svc.viewRequests([row], now, externalTransaction);
  return { request: view };
}

// ── Maintenance (appelée par le balayage planifié) ───────────────────────

// ── Renvoi manuel (Super Admin, "Retry email") — §10 du ticket SMTP ───────
// Ne crée JAMAIS une 2e demande : recharge et met à jour la MÊME ligne. Un
// clic manuel n'est jamais bloqué par cfg.maxEmailRetries (action humaine
// explicite), contrairement à retryPendingEmails() (balayage automatique).
async function retryRequestEmail(id, { now = svc.getNow() } = {}) {
  const row = await AuthRequest.findByPk(id);
  if (!row) throw new ComplianceError(404, "NOT_FOUND", "Request not found.", "Demande introuvable.");
  const emailStatus = await sendRequestEmail(row, { now });
  logger.info(`[PRODUCTION-AUTHORIZATION] EMAIL RETRY (manuel) request=${row.id} status=${emailStatus} retryCount=${row.retryCount}`);
  const [view] = await svc.viewRequests([row], now);
  return view;
}

/** Renvoie les e-mails de demandes non partis (PENDING/FAILED), nombre d'essais borné. */
async function retryPendingEmails({ now = svc.getNow(), transaction } = {}) {
  const rows = await AuthRequest.findAll({
    where: {
      status: "PENDING",
      emailStatus: { [Op.in]: ["PENDING", "FAILED"] },
      retryCount: { [Op.lt]: cfg.maxEmailRetries },
      [Op.or]: [{ lastEmailAttemptAt: null }, { lastEmailAttemptAt: { [Op.lt]: new Date(now.getTime() - 10 * 60 * 1000) } }],
    },
    transaction,
  });
  const out = [];
  for (const row of rows) {
    const s = await sendRequestEmail(row, { now, transaction });
    logger.info(`[PRODUCTION-AUTHORIZATION] EMAIL RETRY request=${row.id} status=${s} retryCount=${row.retryCount}`);
    out.push({ id: row.id, emailStatus: s });
  }
  return out;
}

/** Persiste l'état EXPIRED (demandes non traitées et autorisations non utilisées échues). */
async function expireStale({ now = svc.getNow() } = {}) {
  const [pending] = await sequelize.query(
    `UPDATE production_compliance_authorization_requests SET status = 'EXPIRED', "updatedAt" = :now
      WHERE status = 'PENDING' AND "expiresAt" IS NOT NULL AND "expiresAt" <= :now`,
    { replacements: { now } }
  );
  await sequelize.query(
    `UPDATE production_compliance_authorization_requests r SET status = 'EXPIRED', "updatedAt" = :now
      WHERE r.status = 'APPROVED'
        AND r."expiresAt" IS NOT NULL AND r."expiresAt" <= :now
        AND NOT EXISTS (
          SELECT 1 FROM production_compliance_authorizations a
           WHERE a.id::text IN (SELECT jsonb_array_elements_text(r."createdAuthorizationIds")) AND a."usedAt" IS NOT NULL
        )`,
    { replacements: { now } }
  );
  return pending;
}

module.exports = {
  buildRequestEmail,
  sendRequestEmail,
  createRequest,
  listRequests,
  myRequests,
  requestStats,
  approveRequest,
  rejectRequest,
  retryRequestEmail,
  retryPendingEmails,
  expireStale,
  STATUS_FR,
};
