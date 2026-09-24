"use strict";

const svc = require("../services/compliance.service");
const alerts = require("../services/alerts.service");
const requests = require("../services/requests.service");
const mail = require("../services/mail");
const logger = require("../../../utils/logger");

function fail(res, err, where) {
  if (err instanceof svc.ComplianceError) return res.status(err.status).json(err.toJSON());
  logger.error(`[COMPLIANCE] ${where}: ${err.stack || err.message}`);
  return res.status(500).json({ success: false, message: "Production compliance request failed" });
}

// Réservé aux responsables : e-mail explicitement configuré (cfg.managers) OU
// Super Admin par RÔLE RÉEL EN BASE (admin/superadmin/superadmin2 — même liste
// que requireMaintenanceManager.js, système de permissions déjà existant,
// jamais inventé) — toujours revérifié en base, jamais seulement le JWT.
async function requireManager(req, res, next) {
  try {
    const user = await svc.findUserByEmail(req.user?.email);
    const valid = !!user && user.id === req.user.sub && user.isActive !== false;
    const isSuperAdmin = valid && svc.isSuperAdminRole(user.role);
    const isManager = valid && (svc.isManagerEmail(user.email) || isSuperAdmin);
    // Debug §15 — JAMAIS le JWT ni aucun secret, uniquement userId/email/rôle/booléens.
    logger.info(
      `[PRODUCTION-COMPLIANCE ACCESS] userId: ${user?.id || "-"} | email: ${req.user?.email || "-"} | role: ${user?.role || "-"} | isSuperAdmin: ${isSuperAdmin} | isComplianceManager: ${isManager} | access: ${isManager ? "GRANTED" : "DENIED"}`
    );
    if (!isManager) {
      return res.status(403).json({ success: false, code: "NOT_A_MANAGER", message: "Only a production compliance manager can access this." });
    }
    return next();
  } catch (err) {
    return fail(res, err, "requireManager");
  }
}

const me = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.getMyStatus({ email: req.user.email, userId: req.user.sub }) });
  } catch (err) {
    fail(res, err, "me");
  }
};

const list = async (req, res) => {
  try {
    const { from, to, production, userId, status } = req.query;
    res.json({ success: true, data: await svc.getComplianceRows({ from, to, production, userId, status }) });
  } catch (err) {
    fail(res, err, "list");
  }
};

const summary = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.getSummary({ date: req.query.date }) });
  } catch (err) {
    fail(res, err, "summary");
  }
};

const listAuths = async (req, res) => {
  try {
    const { from, to, production, userId } = req.query;
    res.json({ success: true, data: await svc.listAuthorizations({ from, to, production, userId }) });
  } catch (err) {
    fail(res, err, "listAuths");
  }
};

const createAuth = async (req, res) => {
  try {
    const { production, date, type, reason } = req.body || {};
    const data = await svc.createAuthorization({ managerId: req.user.sub, productionKey: production, date, type, reason });
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err, "createAuth");
  }
};

const revokeAuth = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.revokeAuthorization({ managerId: req.user.sub, authorizationId: req.params.id }) });
  } catch (err) {
    fail(res, err, "revokeAuth");
  }
};

// Déclenche le contrôle maintenant (idempotent) — utile pour vérifier sans attendre 14:30 / 22:00.
const runCheckNow = async (req, res) => {
  try {
    res.json({ success: true, data: await alerts.sweepAll() });
  } catch (err) {
    fail(res, err, "runCheckNow");
  }
};

// ── Demandes d'autorisation de régularisation ──

// Création : uniquement par un compte PROD 1 / PROD 2 (jamais d'auto-autorisation).
// missingDate(s) ne sont JAMAIS lus depuis le corps : les dates manquantes sont
// toujours recalculées côté serveur (voir requests.service.createRequest) —
// un client ne peut jamais faire créer une demande pour des dates inventées.
// requestedDate (date exacte du 403 direct reçu par le client) est transmise
// mais JAMAIS prise telle quelle : requests.createRequest la revérifie
// indépendamment (svc.isEligibleForBackfillRequest) avant de l'inclure.
// production/missingDates/authorizationType éventuellement envoyés par le
// client (contexte du 403 affiché en Flutter) sont ignorés côté serveur.
const createRequest = async (req, res) => {
  try {
    const { reason, requestedDate } = req.body || {};
    const out = await requests.createRequest({ userId: req.user.sub, email: req.user.email, reason, requestedDate });
    // Debug §16 — la notification Super Admin/manager (Notification.create) et l'e-mail
    // sont créés/tentés à l'intérieur de requests.createRequest ; on en trace le résultat
    // ici pour rester visible même si la réponse HTTP a déjà été journalisée ailleurs.
    logger.info(
      `[PRODUCTION-COMPLIANCE] Notification created: ${out.alreadyPending ? "reused-existing" : true} | Email sent: ${out.request?.emailStatus === "SENT"} (status=${out.request?.emailStatus || "-"})`
    );
    res.status(out.alreadyPending ? 200 : 201).json({ success: true, data: out.request, alreadyPending: out.alreadyPending });
  } catch (err) {
    fail(res, err, "createRequest");
  }
};

const myRequests = async (req, res) => {
  try {
    res.json({ success: true, data: await requests.myRequests(req.user.sub) });
  } catch (err) {
    fail(res, err, "myRequests");
  }
};

const listRequests = async (req, res) => {
  try {
    const { status, production, userId } = req.query;
    const data = await requests.listRequests({ status, production, userId });
    logger.info(`[PRODUCTION-COMPLIANCE] GET requests: user=${req.user?.email} | HTTP status: 200 | count=${data.length}${status ? ` (filter status=${status})` : ""}`);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, "listRequests");
  }
};

const approveRequest = async (req, res) => {
  try {
    const data = await requests.approveRequest({ managerId: req.user.sub, id: req.params.id, note: req.body?.note });
    res.json({ success: true, data: data.request, authorizationIds: data.authorizationIds });
  } catch (err) {
    fail(res, err, "approveRequest");
  }
};

const rejectRequest = async (req, res) => {
  try {
    const data = await requests.rejectRequest({ managerId: req.user.sub, id: req.params.id, note: req.body?.note });
    res.json({ success: true, data: data.request });
  } catch (err) {
    fail(res, err, "rejectRequest");
  }
};

// Compteurs pour le tableau de bord (PENDING/APPROVED/REJECTED/USED/EXPIRED) —
// c'est CE compteur (PENDING), jamais un nombre statique ni le total des
// notifications, qui alimente le badge [N] du menu Administration côté Flutter.
const requestStats = async (req, res) => {
  try {
    const data = await requests.requestStats();
    logger.info(`[PRODUCTION-COMPLIANCE] Pending count: ${data.PENDING ?? 0} (stats=${JSON.stringify(data)})`);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, "requestStats");
  }
};

// Vérifie la connexion SMTP réelle (responsables) — jamais d'identifiants dans la réponse.
// Diagnostic SMTP sécurisé (§4) — host/port/secure en clair, user/from
// MASQUÉS (voir utils/mailer.maskEmail), résultat de transporter.verify() et
// message d'erreur SMTP brut si échec. EMAIL_PASS n'est JAMAIS lu ni renvoyé
// ici — verifyConnection() ne l'expose sous aucune forme.
const smtpCheck = async (req, res) => {
  try {
    const v = await mail.verify();
    res.json({
      success: true,
      data: {
        ok: v.ok,
        host: v.host,
        port: v.port,
        secure: v.secure,
        user: v.user ?? null,
        from: v.from ?? null,
        verify: v.ok ? "OK" : "FAILED",
        error: v.ok ? null : v.error?.message || v.error?.response || "unknown",
      },
    });
  } catch (err) {
    fail(res, err, "smtpCheck");
  }
};

// ── "Retry email" (Super Admin) — §10 du ticket SMTP : ne crée jamais une
// 2e alerte/demande, recharge et met à jour la ligne existante. ──────────
const retryAlertEmail = async (req, res) => {
  try {
    const alert = await alerts.retryAlertEmail(req.params.id);
    res.json({ success: true, data: alert });
  } catch (err) {
    fail(res, err, "retryAlertEmail");
  }
};

const retryRequestEmail = async (req, res) => {
  try {
    const data = await requests.retryRequestEmail(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, "retryRequestEmail");
  }
};

module.exports = { requireManager, me, list, summary, listAuths, createAuth, revokeAuth, runCheckNow, createRequest, myRequests, listRequests, requestStats, approveRequest, rejectRequest, retryAlertEmail, retryRequestEmail, smtpCheck };
