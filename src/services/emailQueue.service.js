"use strict";

// File d'attente d'envoi d'email avec retry + backoff manuel.
//
// Pourquoi : Hostinger (SMTP) peut répondre "451 4.7.1 Ratelimit exceeded"
// (ou un 429) — une erreur TEMPORAIRE, pas un rejet définitif. Avant, une
// telle erreur était journalisée puis silencieusement abandonnée (l'appelant
// recevait quand même une réponse neutre, mais l'email n'était jamais
// réessayé). Désormais chaque email passe par enqueueEmail() : une ligne
// EmailQueue est créée AVANT la première tentative (donc jamais perdue même
// si le process crashe), la première tentative est faite immédiatement
// (comportement inchangé quand le SMTP répond normalement), et seules les
// erreurs 451/429 déclenchent des tentatives automatiques supplémentaires
// (30s, 1min, 2min, 5min — 5 tentatives maximum au total). Toute autre erreur
// SMTP (ex: 554 "Disabled by user from hPanel", une erreur d'auth, etc.) est
// définitive : retenter ne changerait rien tant qu'un humain n'a pas résolu
// le problème côté hébergeur — la ligne passe directement en FAILED après
// une seule tentative, prête pour un renvoi manuel.
//
// L'appelant (ex: POST /auth/forgot-password) ne doit JAMAIS être bloqué ni
// échouer à cause d'un souci SMTP : enqueueEmail() n'est jamais rejetée.

const { sendMail } = require("../utils/mailer");
const EmailQueue = require("../models/EmailQueue");
const logger = require("../utils/logger");

// Registre en mémoire des timers de retry en cours, par jobId — nécessaire
// pour pouvoir réellement ANNULER un envoi programmé (clearTimeout), pas
// seulement marquer la ligne DB comme non pertinente (voir cancelJob()).
// Un timer scheduleRetry() ferme sur l'instance `job` en mémoire (jamais de
// re-fetch DB au déclenchement, voir plus bas) — sans ce registre, annuler
// la ligne en DB ne stopperait pas le setTimeout déjà programmé.
const activeTimers = new Map();

const MAX_ATTEMPTS = 5;
// Délai AVANT la tentative n (n = 2..5) — 4 valeurs pour 4 retries après le
// premier essai immédiat, soit 5 tentatives au total.
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000]; // 30s, 1min, 2min, 5min

// Codes SMTP temporaires (4xx = "réessayer plus tard" par définition RFC
// 5321) que ce cahier des charges désigne explicitement : 451 (ex: Hostinger
// "Ratelimit exceeded") et 429 (limite de débit, renvoyé par certains relais).
function isRetryableSmtpError(err) {
  const code = Number(err?.responseCode);
  return code === 451 || code === 429;
}

function describeError(err) {
  return {
    responseCode: Number.isFinite(Number(err?.responseCode)) ? Number(err.responseCode) : null,
    response: err?.response ? String(err.response).slice(0, 500) : null,
    message: err?.message ? String(err.message).slice(0, 500) : null,
  };
}

/**
 * Crée une ligne EmailQueue et tente l'envoi immédiatement. Ne rejette
 * jamais — retourne toujours un statut, y compris en cas d'échec.
 * @returns {Promise<{jobId: string, status: string}>}
 */
async function enqueueEmail({ to, subject, text, html, context = null, meta = null, userId = null }) {
  let job;
  try {
    job = await EmailQueue.create({
      to,
      subject,
      text: text || null,
      html: html || null,
      context,
      meta,
      userId,
      status: "PENDING",
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
    });
  } catch (err) {
    // Échec de la création elle-même (DB indisponible) — on ne peut même pas
    // mettre en file. On journalise et on abandonne proprement : l'appelant
    // ne doit jamais planter pour autant.
    logger.error("EMAIL_QUEUE: impossible de créer la ligne (DB)", { to, error: err.message });
    return { jobId: null, status: "FAILED" };
  }

  await processJob(job);
  return { jobId: job.id, status: job.status };
}

/**
 * Exécute UNE tentative d'envoi pour `job` (attempt = job.attempts + 1) et
 * dispatch vers markSent / retryJob / markFailed selon le résultat.
 */
async function processJob(job) {
  const attemptNumber = job.attempts + 1;
  const now = new Date();

  logger.info("EMAIL_QUEUE: tentative d'envoi", {
    jobId: job.id,
    email: job.to,
    attempt: attemptNumber,
    maxAttempts: job.maxAttempts,
    date: now.toISOString(),
  });

  try {
    const info = await sendMail({ to: job.to, subject: job.subject, text: job.text, html: job.html });
    await markSent(job, { attemptNumber, now, info });
  } catch (err) {
    const errInfo = describeError(err);
    const retryable = isRetryableSmtpError(err);

    // Journalisation précise demandée : email, responseCode, response, date,
    // nombre de tentatives — jamais masquée, même si la réponse HTTP de
    // l'appelant reste neutre pour le client final.
    logger.error("EMAIL_QUEUE: tentative échouée", {
      jobId: job.id,
      email: job.to,
      responseCode: errInfo.responseCode,
      response: errInfo.response,
      message: errInfo.message,
      date: now.toISOString(),
      attempt: attemptNumber,
      maxAttempts: job.maxAttempts,
      retryable,
    });

    // attemptNumber = numéro de la tentative qui VIENT d'échouer (1-indexé).
    // Elle n'a droit à un retry que s'il reste au moins une tentative après
    // elle, donc strictement < maxAttempts (5 < 5 → false → la 5e tentative
    // échouée ne reprogramme rien et tombe dans markFailed). Vérifié par audit
    // (voir historique) + preuve par logs : aucun off-by-one ici.
    const canRetry = retryable && attemptNumber < job.maxAttempts;

    if (canRetry) {
      await retryJob(job, { attemptNumber, now, errInfo });
    } else {
      await markFailed(job, { attemptNumber, now, errInfo });
    }
  }
}

async function markSent(job, { attemptNumber, now, info }) {
  await job.update({
    status: "SENT",
    attempts: attemptNumber,
    lastAttemptAt: now,
    sentAt: now,
    lastResponseCode: null,
    lastResponse: info?.response ? String(info.response).slice(0, 500) : null,
    lastErrorMessage: null,
    nextAttemptAt: null,
  });
  logger.info("EMAIL_QUEUE: envoi réussi", {
    jobId: job.id, email: job.to, attempt: attemptNumber, messageId: info?.messageId,
  });
}

/**
 * Programme le prochain essai puis persiste l'état RETRYING.
 *
 * Ordre volontaire : scheduleRetry() (synchrone, aucun I/O) est appelé AVANT
 * le `await job.save()` (I/O réel vers la DB) — pour ne jamais faire dépendre
 * l'enregistrement du prochain retry de la durée d'un aller-retour DB.
 */
async function retryJob(job, { attemptNumber, now, errInfo }) {
  const delayMs = RETRY_DELAYS_MS[attemptNumber - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const nextAttemptAt = new Date(now.getTime() + delayMs);

  // Mutation en mémoire immédiate : le callback programmé par scheduleRetry
  // ferme sur cette même instance `job` (pas de re-fetch DB au déclenchement,
  // voir scheduleRetry) — il doit donc déjà voir le bon statut/attempts.
  job.set({
    status: "RETRYING",
    attempts: attemptNumber,
    lastAttemptAt: now,
    lastResponseCode: errInfo.responseCode,
    lastResponse: errInfo.response,
    lastErrorMessage: errInfo.message,
    nextAttemptAt,
  });

  scheduleRetry(job, delayMs);

  await job.save();

  logger.info("EMAIL_QUEUE: nouvelle tentative programmée", {
    jobId: job.id,
    email: job.to,
    delayMs,
    nextAttemptAt: nextAttemptAt.toISOString(),
    attemptsLeft: job.maxAttempts - attemptNumber,
  });
}

/**
 * Plus de tentative possible (max atteint, ou erreur non retryable dès le
 * premier échec) — on conserve tout pour un renvoi manuel :
 * status=FAILED, nextAttemptAt=null, sentAt=null, lastErrorMessage=erreur SMTP.
 */
async function markFailed(job, { attemptNumber, now, errInfo }) {
  job.set({
    status: "FAILED",
    attempts: attemptNumber,
    lastAttemptAt: now,
    lastResponseCode: errInfo.responseCode,
    lastResponse: errInfo.response,
    lastErrorMessage: errInfo.message,
    nextAttemptAt: null,
    sentAt: null,
  });
  await job.save();

  logger.error("EMAIL_QUEUE: échec définitif — conservé pour renvoi manuel", {
    jobId: job.id,
    email: job.to,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    responseCode: errInfo.responseCode,
    response: errInfo.response,
  });
}

/**
 * Programme le prochain appel à processJob(job) après `delayMs`. Ferme sur
 * l'instance `job` déjà à jour en mémoire (voir retryJob) — AUCUN aller-
 * retour DB au déclenchement du timer, pour ne jamais introduire de délai
 * d'attente imprévisible entre "le timer se déclenche" et "le prochain
 * timer est programmé".
 *
 * .unref() : un setTimeout ne doit jamais, à lui seul, garder le process
 * Node vivant (cohérent avec le reste du code, voir models/Project.js).
 */
function scheduleRetry(job, delayMs) {
  const timer = setTimeout(async () => {
    activeTimers.delete(job.id);
    try {
      if (job.status !== "RETRYING") return; // déjà traité/annulé entre-temps
      await processJob(job);
    } catch (err) {
      logger.error("EMAIL_QUEUE: erreur pendant une tentative programmée", { jobId: job.id, error: err.message });
    }
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  activeTimers.set(job.id, timer);
}

/**
 * Recherche un job encore actif (PENDING/RETRYING) pour un utilisateur et un
 * contexte donnés — utilisé par le MFA pour éviter de créer un deuxième job
 * tant qu'un premier envoi/retry est en cours (voir mfa.service.js).
 */
async function findActiveJob({ userId, context }) {
  return EmailQueue.findOne({
    where: { userId, context, status: ["PENDING", "RETRYING"] },
    order: [["createdAt", "DESC"]],
  });
}

/**
 * Annule un job encore PENDING/RETRYING : stoppe le timer de retry s'il y en
 * a un (clearTimeout réel, pas seulement un marquage DB) et passe le statut
 * à CANCELLED. Utilisé quand un OTP est validé avant que son email n'ait
 * fini d'être délivré — l'envoi devient inutile (voir
 * mfa.service.js `cleanupAfterVerification`).
 */
async function cancelJob(jobId, reason = "superseded") {
  const timer = activeTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(jobId);
  }

  const job = await EmailQueue.findByPk(jobId);
  if (!job || !["PENDING", "RETRYING"].includes(job.status)) return false;

  await job.update({ status: "CANCELLED", nextAttemptAt: null, lastErrorMessage: reason });
  logger.info("EMAIL_QUEUE: job annulé (devenu inutile)", { jobId, reason });
  return true;
}

/**
 * À appeler une fois au démarrage du serveur (jamais en test — voir
 * app.js `start()`, qui ne s'exécute pas sous Jest). Reprogramme toute ligne
 * PENDING/RETRYING encore éligible, pour ne rien perdre après un redémarrage
 * pendant une série de tentatives.
 */
async function resumePendingEmailQueue() {
  const { Op } = require("sequelize");
  let jobs;
  try {
    jobs = await EmailQueue.findAll({
      where: { status: ["PENDING", "RETRYING"], attempts: { [Op.lt]: MAX_ATTEMPTS } },
    });
  } catch (err) {
    logger.error("EMAIL_QUEUE: échec lecture des jobs en attente au démarrage", { error: err.message });
    return;
  }

  if (jobs.length === 0) return;
  logger.info("EMAIL_QUEUE: reprise au démarrage", { count: jobs.length });

  for (const job of jobs) {
    const delayMs = job.nextAttemptAt ? Math.max(0, job.nextAttemptAt.getTime() - Date.now()) : 0;
    if (delayMs === 0) {
      // Échéance déjà passée pendant l'arrêt du serveur → on retente tout de suite.
      processJob(job).catch((err) =>
        logger.error("EMAIL_QUEUE: échec reprise immédiate", { jobId: job.id, error: err.message })
      );
    } else {
      scheduleRetry(job, delayMs);
    }
  }
}

module.exports = {
  enqueueEmail,
  resumePendingEmailQueue,
  findActiveJob,
  cancelJob,
  // Exportés pour les tests (backoff attendu : 30s/1min/2min/5min, 5 tentatives max).
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  isRetryableSmtpError,
};
