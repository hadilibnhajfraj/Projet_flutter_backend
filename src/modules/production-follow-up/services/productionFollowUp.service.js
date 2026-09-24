"use strict";

// ═══════════════════════════════════════════════════════════════════════
// "Production Follow-up" — suivi automatique des journées de production
// SANS AUCUNE fiche (PROMESH/PROBAR confondus, via svc.sheetsInRange — donc
// PROBAR est déjà couvert, §6, puisque production_1/production_2 peuvent
// créer des fiches des deux modules).
//
// COMPLÉMENTAIRE à Production Compliance (§2/§16/§20) — ne modifie STRICTEMENT
// RIEN au module production-compliance existant (alerts.service.js,
// requests.service.js, computeDays, Missing production sheets, Backfill
// authorization) : ce module se contente de LIRE cfg/sheetsInRange/mail et
// d'écrire dans SA PROPRE table (production_follow_up_alerts), jamais dans
// production_compliance_alerts.
//
// Différence de règle avec Production Compliance (volontaire, §1/§4) :
// Production Compliance regarde si une fiche a été créée DANS LA FENÊTRE
// horaire obligatoire (window-based). Production Follow-up regarde si AU
// MOINS UNE fiche existe pour la date, sans condition d'heure — un contrôle
// plus simple, complémentaire, pour le suivi macro des journées "à zéro".
//
// Anti-duplication (§11) : contrainte unique (productionType, productionDate)
// + statut PENDING tant que l'e-mail n'est pas confirmé envoyé — un cron qui
// tourne plusieurs fois ne crée jamais 2 lignes ni n'envoie jamais 2 e-mails
// pour la même anomalie déjà EMAIL_SENT/RESOLVED/IGNORED.
// ═══════════════════════════════════════════════════════════════════════

const { QueryTypes, Op } = require("sequelize");
const { v4: uuidv4 } = require("uuid");

const { sequelize } = require("../../../db");
const FollowUpAlert = require("../../../models/ProductionFollowUpAlert");
// Réutilisation DIRECTE de Production Compliance — jamais un 2e cfg, un 2e
// mailer ou une 2e définition des productions/plages (§6, §16, §20).
const svc = require("../../production-compliance/services/compliance.service");
const mail = require("../../production-compliance/services/mail");
const logger = require("../../../utils/logger");

const { cfg } = svc;
const MAX_EMAIL_RETRIES = 5;
const LOOKBACK_DAYS = 30; // fenêtre de retry/résolution automatique des anomalies non closes

function isEnabled() {
  return process.env.PRODUCTION_FOLLOW_UP_ENABLED !== "false" && cfg.enabled;
}

// Compte TOUTES les fiches de la journée (PROMESH + PROBAR, réutilise
// sheetsInRange), sans condition d'heure — §1/§4.
async function sheetsCountForDate(userId, dateStr, transaction) {
  const rows = await svc.sheetsInRange(userId, dateStr, dateStr, transaction);
  return rows.length;
}

// La journée est "terminée" une fois la fenêtre de production la plus
// tardive dépassée — jamais avant (§5 : jamais aujourd'hui avant la fin).
function dayIsOver(dateStr, now) {
  const ends = Object.values(cfg.productions).map((p) => svc.windowFor(p, dateStr).end.getTime());
  return now.getTime() >= Math.max(...ends);
}

// ── Réservation idempotente d'une ligne (INSERT ON CONFLICT DO NOTHING),
// puis lecture de la ligne (nouvelle ou déjà existante) — jamais 2 lignes
// pour la même production+date (§11).
async function claimOrGetAlert({ prod, date, userId, userEmail, sheetsCount, now, transaction }) {
  await sequelize.query(
    `INSERT INTO production_follow_up_alerts
       (id, "productionType", "productionDate", "userId", "userEmail", "sheetsCount", status, "checkedAt", "createdAt", "updatedAt")
     VALUES (:id, :pt, :date, :uid, :email, :sheetsCount, 'PENDING', :now, :now, :now)
     ON CONFLICT ("productionType", "productionDate") DO NOTHING`,
    { replacements: { id: uuidv4(), pt: prod.key, date, uid: userId, email: userEmail, sheetsCount, now }, transaction }
  );
  return FollowUpAlert.findOne({ where: { productionType: prod.key, productionDate: date }, transaction });
}

// Trouve la fiche qui régularise l'anomalie (preuve traçable, §15) — la plus
// ancienne fiche réelle (PROMESH ou PROBAR) créée par cet utilisateur pour
// cette date de production.
async function findResolvingFiche(userId, dateStr, transaction) {
  const rows = await sequelize.query(
    `SELECT id, 'PROMESH' AS type, "createdAt" FROM por_promesh WHERE "createdBy" = :uid AND "dateProduction" = :date
     UNION ALL
     SELECT id, 'PROBAR', "createdAt" FROM industrial_records WHERE "createdBy" = :uid AND module = 'probar' AND "dateFiche" = :date
     ORDER BY 3 ASC LIMIT 1`,
    { replacements: { uid: userId, date: dateStr }, type: QueryTypes.SELECT, transaction }
  );
  return rows[0] || null;
}

// §15 — une fiche existe maintenant pour une date/production déjà en
// anomalie (PENDING ou EMAIL_SENT) : régularisation automatique.
async function resolveIfPending({ prod, date, userId, sheetsCount, now, transaction }) {
  const alert = await FollowUpAlert.findOne({ where: { productionType: prod.key, productionDate: date }, transaction });
  if (!alert || alert.status === "RESOLVED" || alert.status === "IGNORED") return null;
  const fiche = await findResolvingFiche(userId, date, transaction);
  await alert.update(
    { status: "RESOLVED", resolvedAt: now, sheetsCount, resolvedByFicheType: fiche?.type || null, resolvedByFicheId: fiche?.id || null },
    { transaction }
  );
  logger.info(`[PRODUCTION-FOLLOW-UP]\nRESOLVED\nproduction=${prod.key}\ndate=${date}\nresolvedByFicheType=${fiche?.type || "-"}\nresolvedByFicheId=${fiche?.id || "-"}`);
  return alert;
}

// ── Gabarits e-mail (§8/§9/§10) — texte + HTML, français, jamais envoyé à
// l'utilisateur de production (§7 : uniquement cfg.alertRecipients).
function shiftLabel(prod) {
  return `${prod.label} (${prod.start} – ${prod.end})`;
}

function buildSingleEmail({ prod, userEmail }, dateStr) {
  const dateFr = svc.frDate(dateStr);
  const subject = `[PRODUCTION] Fiche de production manquante — ${dateFr}`;
  const text = [
    "Bonjour,",
    "",
    "Un contrôle automatique de production a détecté l'absence",
    "de fiche de production pour la journée suivante :",
    "",
    `Date : ${dateFr}`,
    `Production : ${prod.label}`,
    `Shift : ${shiftLabel(prod)}`,
    `Utilisateur concerné : ${userEmail || prod.email}`,
    "",
    "Aucune fiche de production n'a été enregistrée pour cette journée.",
    "",
    "Merci d'effectuer le suivi nécessaire et de vérifier la situation",
    "dans l'application Probar.",
    "",
    "Cordialement,",
    "",
    "Probar",
    "CBI Tunisia",
    "Système automatique de suivi de production",
  ].join("\n");
  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${k}</td><td style="padding:4px 0"><b>${v}</b></td></tr>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<h2 style="color:#b00020;margin:0 0 12px">Fiche de production manquante</h2>
<table>${row("Date", dateFr)}${row("Production", prod.label)}${row("Shift", shiftLabel(prod))}${row("Utilisateur concerné", userEmail || prod.email)}</table>
<p>Aucune fiche de production n'a été enregistrée pour cette journée.<br>
Merci d'effectuer le suivi nécessaire et de vérifier la situation dans l'application Probar.</p>
<p>Cordialement,<br>Probar — CBI Tunisia<br><i>Système automatique de suivi de production</i></p></div>`;
  return { subject, text, html };
}

function buildRecapEmail(missing, dateStr) {
  const dateFr = svc.frDate(dateStr);
  const subject = `[PRODUCTION] Journée de production à vérifier — ${dateFr}`;
  const bulletsText = missing.map((m) => `• ${m.prod.label} — aucune fiche (${m.userEmail || m.prod.email})`).join("\n");
  const text = [
    "Bonjour,",
    "",
    "Un contrôle automatique de production a détecté des anomalies",
    "pour la journée suivante :",
    "",
    `Date : ${dateFr}`,
    "",
    "Anomalies détectées :",
    "",
    bulletsText,
    "",
    "Merci d'effectuer le suivi nécessaire et de vérifier la situation",
    "dans l'application Probar.",
    "",
    "Cordialement,",
    "",
    "Probar",
    "CBI Tunisia",
    "Système automatique de suivi de production",
  ].join("\n");
  const bulletsHtml = missing.map((m) => `<li>${m.prod.label} — aucune fiche (${m.userEmail || m.prod.email})</li>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<h2 style="color:#b00020;margin:0 0 12px">Journée de production à vérifier</h2>
<p>Date : <b>${dateFr}</b></p>
<p>Anomalies détectées :</p>
<ul>${bulletsHtml}</ul>
<p>Merci d'effectuer le suivi nécessaire et de vérifier la situation dans l'application Probar.</p>
<p>Cordialement,<br>Probar — CBI Tunisia<br><i>Système automatique de suivi de production</i></p></div>`;
  return { subject, text, html };
}

// ── Contrôle d'UNE date, toutes les productions — insère/retente/résout,
// puis envoie AU PLUS UN e-mail groupé pour cette date (§10).
async function checkAndMaybeEmail(dateStr, { now = svc.getNow(), transaction } = {}) {
  if (!svc.isWorkingDay(dateStr)) return { date: dateStr, skipped: "non_working" };

  const missing = [];
  for (const prod of Object.values(cfg.productions)) {
    logger.info(`[PRODUCTION-FOLLOW-UP]\nchecking production=${prod.key}\ndate=${dateStr}`);
    const user = await svc.findUserByEmail(prod.email, transaction);
    if (!user || user.isActive === false) {
      logger.warn(`[PRODUCTION-FOLLOW-UP] user missing/inactive for ${prod.key} (${prod.email}) — skipped`);
      continue;
    }
    const count = await sheetsCountForDate(user.id, dateStr, transaction);
    if (count > 0) {
      logger.info(`[PRODUCTION-FOLLOW-UP]\n${prod.key}\ndate=${dateStr}\nsheets=${count}\nstatus=OK`);
      await resolveIfPending({ prod, date: dateStr, userId: user.id, sheetsCount: count, now, transaction });
      continue;
    }
    logger.info(`[PRODUCTION-FOLLOW-UP]\n${prod.key}\ndate=${dateStr}\nsheets=0\nstatus=MISSING`);
    const alert = await claimOrGetAlert({ prod, date: dateStr, userId: user.id, userEmail: user.email, sheetsCount: 0, now, transaction });
    if (alert && alert.status === "PENDING" && alert.retryCount < MAX_EMAIL_RETRIES) {
      missing.push({ prod, userEmail: user.email, alert });
    }
  }

  if (!missing.length) return { date: dateStr, missing: 0 };

  const { subject, text, html } = missing.length === 1 ? buildSingleEmail(missing[0], dateStr) : buildRecapEmail(missing, dateStr);

  for (const m of missing) {
    await sequelize.query(
      `UPDATE production_follow_up_alerts SET "lastEmailAttemptAt" = :now, "retryCount" = "retryCount" + 1, "updatedAt" = :now WHERE id = :id`,
      { replacements: { now, id: m.alert.id }, transaction }
    );
  }

  try {
    const info = await mail.send({ to: cfg.alertRecipients, subject, text, html });
    for (const m of missing) {
      await sequelize.query(
        `UPDATE production_follow_up_alerts
            SET status = 'EMAIL_SENT', "emailSentAt" = :now, "emailError" = NULL, recipients = :recipients::jsonb, "updatedAt" = :now
          WHERE id = :id`,
        { replacements: { now, id: m.alert.id, recipients: JSON.stringify(cfg.alertRecipients) }, transaction }
      );
    }
    logger.info(`[PRODUCTION-FOLLOW-UP]\nEMAIL SENT\nto=${cfg.alertRecipients.join(",")}`);
    return { date: dateStr, missing: missing.length, emailResult: "sent", messageId: info?.messageId };
  } catch (err) {
    const errMsg = String(err?.message || err).slice(0, 1000);
    for (const m of missing) {
      await sequelize.query(`UPDATE production_follow_up_alerts SET "emailError" = :err, "updatedAt" = :now WHERE id = :id`, {
        replacements: { err: errMsg, now, id: m.alert.id },
        transaction,
      });
    }
    // §17 — un échec SMTP ne fait JAMAIS passer status à EMAIL_SENT ; la ligne
    // reste PENDING et sera retentée au prochain contrôle.
    logger.error(`[PRODUCTION-FOLLOW-UP]\nEMAIL FAILED\nerror=${errMsg}`);
    return { date: dateStr, missing: missing.length, emailResult: "failed", error: errMsg };
  }
}

let running = null;

/**
 * Balayage quotidien (§3) : vérifie la journée du jour UNIQUEMENT une fois
 * sa fenêtre de production terminée (§5), PLUS toute date récente encore
 * PENDING (retry d'un e-mail en échec, ou détection de régularisation §15) —
 * jamais une date future, jamais avant cfg.startDate (§5).
 */
async function sweepFollowUp({ now = svc.getNow() } = {}) {
  if (!isEnabled()) {
    logger.info("[PRODUCTION-FOLLOW-UP] PRODUCTION_FOLLOW_UP_ENABLED=false — skipped.");
    return { skipped: "disabled" };
  }
  if (running) return running; // pas de balayages concurrents dans ce process
  running = (async () => {
    const today = svc.todayStr(now);
    logger.info(`[PRODUCTION-FOLLOW-UP]\nDAILY CHECK STARTED\ndate=${today}`);

    const dates = new Set();
    if (dayIsOver(today, now)) dates.add(today);

    const outstanding = await FollowUpAlert.findAll({
      where: { status: "PENDING", productionDate: { [Op.gte]: cfg.startDate, [Op.lte]: today } },
      attributes: ["productionDate"],
    });
    for (const o of outstanding) dates.add(o.productionDate);

    // Borne de sécurité (retry/résolution) — ne remonte jamais plus loin que
    // LOOKBACK_DAYS, ni avant cfg.startDate (§5).
    const cutoff = svc.shiftDate(today, -LOOKBACK_DAYS);
    const results = [];
    for (const date of [...dates].filter((d) => d >= cutoff && d >= cfg.startDate).sort()) {
      results.push(await checkAndMaybeEmail(date, { now }));
    }
    logger.info(`[PRODUCTION-FOLLOW-UP]\nDAILY CHECK FINISHED\ndate=${today}\ndatesChecked=${dates.size}`);
    running = null;
    return results;
  })().catch((err) => {
    running = null;
    logger.error(`[PRODUCTION-FOLLOW-UP] sweep error: ${err.stack || err.message}`);
    return [];
  });
  return running;
}

// ── Renvoi manuel (Super Admin) — ne recrée jamais une 2e ligne, jamais
// bloqué par MAX_EMAIL_RETRIES (action humaine explicite).
async function retryEmail(id, { now = svc.getNow() } = {}) {
  const alert = await FollowUpAlert.findByPk(id);
  if (!alert) {
    const err = new Error("Alert not found.");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  if (alert.status !== "PENDING") {
    const err = new Error(`This alert is already ${alert.status}.`);
    err.status = 409;
    err.code = "INVALID_STATE";
    throw err;
  }
  const prod = cfg.productions[alert.productionType];
  const { subject, text, html } = buildSingleEmail({ prod, userEmail: alert.userEmail }, alert.productionDate);
  await alert.update({ lastEmailAttemptAt: now, retryCount: alert.retryCount + 1 });
  try {
    const info = await mail.send({ to: cfg.alertRecipients, subject, text, html });
    await alert.update({ status: "EMAIL_SENT", emailSentAt: now, emailError: null, recipients: cfg.alertRecipients });
    logger.info(`[PRODUCTION-FOLLOW-UP]\nEMAIL SENT (retry)\nto=${cfg.alertRecipients.join(",")} messageId=${info?.messageId || "-"}`);
  } catch (err) {
    await alert.update({ emailError: String(err?.message || err).slice(0, 1000) });
    logger.error(`[PRODUCTION-FOLLOW-UP]\nEMAIL FAILED (retry)\nerror=${err?.message}`);
  }
  return alert.reload();
}

// Fermeture manuelle sans e-mail (faux positif confirmé par un responsable).
async function ignoreAlert(id, { managerId, reason, now = svc.getNow() } = {}) {
  const alert = await FollowUpAlert.findByPk(id);
  if (!alert) {
    const err = new Error("Alert not found.");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  if (alert.status === "RESOLVED" || alert.status === "IGNORED") {
    const err = new Error(`This alert is already ${alert.status}.`);
    err.status = 409;
    err.code = "INVALID_STATE";
    throw err;
  }
  await alert.update({ status: "IGNORED", ignoredAt: now, ignoredBy: managerId, ignoredReason: reason ? String(reason).trim().slice(0, 1000) : null });
  logger.info(`[PRODUCTION-FOLLOW-UP]\nIGNORED\nid=${alert.id}\nby=${managerId}`);
  return alert;
}

async function listAlerts({ status, from, to } = {}) {
  const where = {};
  if (status) where.status = status;
  if (from || to) where.productionDate = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  return FollowUpAlert.findAll({ where, order: [["productionDate", "DESC"], ["productionType", "ASC"]], limit: 500 });
}

module.exports = {
  isEnabled,
  sheetsCountForDate,
  dayIsOver,
  checkAndMaybeEmail,
  sweepFollowUp,
  retryEmail,
  ignoreAlert,
  listAlerts,
  buildSingleEmail,
  buildRecapEmail,
  MAX_EMAIL_RETRIES,
  LOOKBACK_DAYS,
};
