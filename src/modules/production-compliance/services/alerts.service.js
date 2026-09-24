"use strict";

const dayjs = require("dayjs");
const { QueryTypes } = require("sequelize");
const { v4: uuidv4 } = require("uuid");

const { sequelize } = require("../../../db");
const Alert = require("../../../models/ProductionComplianceAlert");
const svc = require("./compliance.service");
const mail = require("./mail");
const requests = require("./requests.service");
const logger = require("../../../utils/logger");

const { cfg } = svc;
const MAX_ATTEMPTS = 3;
const STALE_PENDING_MS = 15 * 60 * 1000;

// ── Modèles d'e-mail (PROD 1 et PROD 2 partagent le gabarit, seuls le nom,
// l'utilisateur et la plage changent) ────────────────────────────────────

function buildAlertEmail({ prod, dateStr, sheetsCount, checkedAt }) {
  const dateFr = svc.frDate(dateStr);
  const period = `${prod.start} → ${prod.end}`;
  const checked = svc.tzNow(checkedAt).format("DD/MM/YYYY [à] HH:mm");
  const link = `${cfg.crmBaseUrl}/production-compliance`;
  const title = `ALERTE PRODUCTION ${prod.key.replace("PROD", "")}`;
  const subject = `[CRM PROBAR] ALERTE — Fiche ${prod.label} non créée — ${dateFr}`;

  const text = [
    title,
    "",
    `Date : ${dateFr}`,
    `Utilisateur : ${prod.email}`,
    `Période obligatoire : ${period}`,
    `Nombre de fiches créées : ${sheetsCount}`,
    `Date et heure de contrôle : ${checked} (heure de Tunis)`,
    "",
    "Aucune fiche de production n'a été créée pendant la période obligatoire.",
    "Merci de vérifier la situation.",
    "",
    `Lien vers le CRM : ${link}`,
  ].join("\n");

  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${k}</td><td style="padding:4px 0"><b>${v}</b></td></tr>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<h2 style="color:#b00020;margin:0 0 12px">${title}</h2>
<table>${row("Date", dateFr)}${row("Utilisateur", prod.email)}${row("Période obligatoire", period)}${row("Nombre de fiches créées", sheetsCount)}${row("Date et heure de contrôle", `${checked} (heure de Tunis)`)}</table>
<p>Aucune fiche de production n'a été créée pendant la période obligatoire.<br>Merci de vérifier la situation.</p>
<p><a href="${link}">Ouvrir Production Compliance dans le CRM</a></p></div>`;
  return { subject, text, html };
}

// ── Contrôle d'une production pour une date (idempotent) ─────────────────

/**
 * Retourne { result, alertId? } avec result ∈
 * disabled | before_start | non_working | window_open | user_missing |
 * ok | sent | failed | already_handled
 */
async function runCheck(prodKey, { now = svc.getNow(), dateStr, transaction } = {}) {
  const prod = cfg.productions[prodKey];
  if (!prod) throw new Error(`Unknown production ${prodKey}`);
  if (!cfg.enabled) return { result: "disabled" };

  const today = svc.todayStr(now);
  const date = dateStr || today;
  if (date < cfg.startDate) return { result: "before_start" };
  if (!svc.isWorkingDay(date)) return { result: "non_working" };

  const win = svc.windowFor(prod, date);
  if (now < win.end) return { result: "window_open" };

  const user = await svc.findUserByEmail(prod.email, transaction);
  if (!user || user.isActive === false) {
    logger.warn(`[COMPLIANCE] ${prod.label}: user ${prod.email} not found/inactive — no check`);
    return { result: "user_missing" };
  }

  // Fiches créées par l'utilisateur, pour CETTE date de production, pendant
  // la plage obligatoire (heure de Tunis).
  const sheets = await svc.sheetsInRange(user.id, date, date, transaction);
  const inWindow = sheets.filter((s) => new Date(s.createdAt) >= win.start && new Date(s.createdAt) <= win.end);
  if (inWindow.length > 0) return { result: "ok", sheetsCount: inWindow.length };

  // Un seul e-mail par (utilisateur, production, date) : on « réserve » la
  // ligne d'alerte de façon atomique avant d'envoyer.
  const alertId = await claimAlert({ prod, user, date, win, now, transaction });
  if (!alertId) return { result: "already_handled" };

  const { subject, text, html } = buildAlertEmail({ prod, dateStr: date, sheetsCount: 0, checkedAt: now });
  await svc.notifyManagers(
    {
      type: "production_compliance_alert",
      title: `Fiche ${prod.label} non créée — ${svc.frDate(date)}`,
      message: `Aucune fiche de production ${prod.label} créée par ${prod.email} pendant la période obligatoire (${prod.start} → ${prod.end}).`,
    },
    transaction
  );
  try {
    const info = await mail.send({ to: cfg.alertRecipients, subject, text, html });
    await sequelize.query(
      `UPDATE production_compliance_alerts
          SET status = 'sent', "emailSentAt" = :now, recipients = :recipients::jsonb, "lastError" = NULL, "updatedAt" = :now
        WHERE id = :id`,
      { replacements: { id: alertId, now, recipients: JSON.stringify(cfg.alertRecipients) }, transaction }
    );
    logger.info(`[COMPLIANCE] alert sent ${prod.label} ${date} → ${cfg.alertRecipients.join(", ")} (${info?.messageId || "no-id"})`);
    return { result: "sent", alertId };
  } catch (err) {
    await sequelize.query(
      `UPDATE production_compliance_alerts SET status = 'failed', "lastError" = :err, "updatedAt" = :now WHERE id = :id`,
      { replacements: { id: alertId, now, err: String(err?.message || err).slice(0, 1000) }, transaction }
    );
    logger.error(`[COMPLIANCE] alert email FAILED ${prod.label} ${date}: ${err?.message}`);
    return { result: "failed", alertId };
  }
}

async function claimAlert({ prod, user, date, win, now, transaction }) {
  const inserted = await sequelize.query(
    `INSERT INTO production_compliance_alerts
       (id, "productionType", "userId", "productionDate", "periodStart", "periodEnd", "sheetsCount", status, attempts, "checkedAt", "createdAt", "updatedAt")
     VALUES (:id, :pt, :uid, :date, :ps, :pe, 0, 'pending', 1, :now, :now, :now)
     ON CONFLICT ("userId", "productionType", "productionDate") DO NOTHING
     RETURNING id`,
    {
      replacements: { id: uuidv4(), pt: prod.key, uid: user.id, date, ps: win.start, pe: win.end, now },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  if (inserted.length) return inserted[0].id;

  // La ligne existe déjà : on ne la reprend que si l'envoi précédent a échoué
  // (nombre d'essais borné) ou est resté « pending » trop longtemps (crash).
  const reclaimed = await sequelize.query(
    `UPDATE production_compliance_alerts
        SET status = 'pending', attempts = attempts + 1, "checkedAt" = :now, "updatedAt" = :now
      WHERE "userId" = :uid AND "productionType" = :pt AND "productionDate" = :date
        AND attempts < :max
        AND (status = 'failed' OR (status = 'pending' AND "updatedAt" < :stale))
      RETURNING id`,
    {
      replacements: { uid: user.id, pt: prod.key, date, now, max: MAX_ATTEMPTS, stale: new Date(now.getTime() - STALE_PENDING_MS) },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  return reclaimed.length ? reclaimed[0].id : null;
}

// ── Balayage : rattrapage au démarrage / relance des envois échoués ──────

let running = null;

/** Exécute le contrôle de toutes les productions pour aujourd'hui + relance les échecs récents. */
async function sweepAll({ now = svc.getNow() } = {}) {
  if (running) return running; // pas de balayages concurrents dans ce process
  running = (async () => {
    const results = [];
    try {
      for (const key of Object.keys(cfg.productions)) {
        results.push({ production: key, ...(await runCheck(key, { now })) });
      }
      // Demandes d'autorisation : renvoi des e-mails non partis + expirations.
      await requests.retryPendingEmails({ now });
      await requests.expireStale({ now });
      // Alertes échouées des 3 derniers jours : nouvel essai.
      const failed = await Alert.findAll({ where: { status: "failed" } });
      const oldest = svc.shiftDate(svc.todayStr(now), -3);
      for (const a of failed) {
        if (a.attempts >= MAX_ATTEMPTS || a.productionDate < oldest) continue;
        results.push({ production: a.productionType, ...(await runCheck(a.productionType, { now, dateStr: a.productionDate })) });
      }
    } catch (err) {
      logger.error(`[COMPLIANCE] sweep error: ${err.stack || err.message}`);
    } finally {
      running = null;
    }
    return results;
  })();
  return running;
}

// ── Renvoi manuel (Super Admin, "Retry email") — §10 ──────────────────────
// Ne crée JAMAIS une 2e alerte (§11) : recharge et met à jour la MÊME ligne.
// Contrairement au balayage automatique (sweepAll), un clic manuel n'est
// jamais bloqué par MAX_ATTEMPTS — c'est une action humaine explicite, pas
// une boucle automatique à borner.
async function retryAlertEmail(id, { now = svc.getNow() } = {}) {
  const alert = await Alert.findByPk(id);
  if (!alert) {
    const err = new Error("Alert not found.");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }

  const prod = cfg.productions[alert.productionType];
  const { subject, text, html } = buildAlertEmail({ prod, dateStr: alert.productionDate, sheetsCount: alert.sheetsCount, checkedAt: alert.checkedAt || now });

  await alert.update({ attempts: alert.attempts + 1, checkedAt: now });
  try {
    const info = await mail.send({ to: cfg.alertRecipients, subject, text, html });
    await alert.update({ status: "sent", emailSentAt: now, recipients: cfg.alertRecipients, lastError: null });
    logger.info(`[COMPLIANCE] alert RETRY sent ${alert.productionType} ${alert.productionDate} → ${cfg.alertRecipients.join(", ")} (${info?.messageId || "no-id"})`);
  } catch (err) {
    await alert.update({ status: "failed", lastError: String(err?.message || err).slice(0, 1000) });
    logger.error(`[COMPLIANCE] alert RETRY FAILED ${alert.productionType} ${alert.productionDate}: ${err?.message}`);
  }
  return alert.reload();
}

module.exports = { runCheck, sweepAll, buildAlertEmail, retryAlertEmail, MAX_ATTEMPTS };
