"use strict";

require("dotenv").config();

// Tests de la file d'attente d'envoi d'email (services/emailQueue.service.js)
// — vérifie que les erreurs SMTP temporaires (451/429, ex: "Ratelimit
// exceeded" côté Hostinger) sont réessayées automatiquement avec le backoff
// attendu (30s/1min/2min/5min, 5 tentatives max), que l'appelant n'est
// JAMAIS rejeté, et qu'une erreur non temporaire (554) échoue définitivement
// dès la première tentative plutôt que de gaspiller des essais inutiles.
//
// utils/mailer est mocké (jamais de vrai envoi) ; le reste (EmailQueue) tape
// la vraie base de dev, comme test/auth.resetPassword.test.js. Les délais de
// backoff sont traversés avec des fake timers Jest (aucune attente réelle).

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn(),
}));

const { sequelize } = require("../src/db");
const EmailQueue = require("../src/models/EmailQueue");
const { sendMail } = require("../src/utils/mailer");
const {
  enqueueEmail,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
} = require("../src/services/emailQueue.service");

const RUN_ID = Date.now();
const emailFor = (label) => `queue-test-${label}-${RUN_ID}@example.com`;
const createdJobIds = [];

function smtpError(responseCode, response) {
  const err = new Error(`Message failed: ${responseCode} ${response}`);
  err.responseCode = responseCode;
  err.response = response;
  err.code = "EMESSAGE";
  return err;
}

// jest.advanceTimersByTimeAsync() déclenche bien le callback setTimeout, mais
// celui-ci enchaîne ensuite de VRAIS appels réseau vers Postgres (EmailQueue
// utilise la base de dev réelle, pas de mock) — un aller-retour I/O réel que
// les fake timers n'attendent pas automatiquement.
//
// Diagnostic confirmé (voir conversation) : on NE bascule PLUS sur
// jest.useRealTimers()/useFakeTimers() ici — jest.useRealTimers() désinstalle
// l'horloge simulée et JETTE les timers déjà programmés (scheduleRetry() pour
// la tentative suivante), qui n'existent plus une fois revenu en fake timers.
// Preuve : jest.getTimerCount() tombait de 2 à 0 entre les deux appels.
//
// À la place : on reste en fake timers tout du long et on attend juste que le
// round-trip DB déjà en cours (déclenché par le timer qui vient de fire)
// aboutisse, via process.nextTick (jamais mocké par Jest, contrairement à
// setTimeout/setImmediate) — l'attente réelle vient du `await
// EmailQueue.findByPk(...)` lui-même (I/O réel via libuv, indépendant du
// régime de timers), pas d'un quelconque minuteur.
async function waitForNextAttempt(jobId, baselineAttempts, maxIterations = 500) {
  let job = await EmailQueue.findByPk(jobId);
  let i = 0;
  while (job.attempts <= baselineAttempts && i < maxIterations) {
    await new Promise((resolve) => process.nextTick(resolve));
    job = await EmailQueue.findByPk(jobId);
    i += 1;
  }
  return job;
}

describe("EmailQueue — retry/backoff SMTP", () => {
  beforeEach(() => {
    sendMail.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    if (createdJobIds.length) await EmailQueue.destroy({ where: { id: createdJobIds } });
    await sequelize.close();
  });

  test("backoff attendu : 30s puis 1min, 2min, 5min", () => {
    expect(RETRY_DELAYS_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  test("succès immédiat → SENT en un seul essai, requête jamais rejetée", async () => {
    sendMail.mockResolvedValueOnce({ messageId: "ok" });

    const to = emailFor("immediate-success");
    const result = await enqueueEmail({ to, subject: "Test", text: "t", html: "<p>t</p>" });
    createdJobIds.push(result.jobId);

    expect(result.status).toBe("SENT");
    expect(sendMail).toHaveBeenCalledTimes(1);

    const job = await EmailQueue.findByPk(result.jobId);
    expect(job.attempts).toBe(1);
    expect(job.sentAt).not.toBeNull();
  });

  test("451 (Ratelimit exceeded) → 1er essai échoue, token/message conservés, retry après 30s réussit", async () => {
    sendMail
      .mockRejectedValueOnce(smtpError(451, "4.7.1 Ratelimit exceeded"))
      .mockResolvedValueOnce({ messageId: "ok-after-retry" });

    const to = emailFor("retry-success");
    const result = await enqueueEmail({ to, subject: "Reset", text: "t", html: "<p>lien</p>" });
    createdJobIds.push(result.jobId);

    // La requête (ici : l'appel à enqueueEmail, équivalent de la requête
    // forgot-password) n'échoue jamais — elle retourne un statut, pas une erreur.
    expect(result.status).toBe("RETRYING");
    expect(sendMail).toHaveBeenCalledTimes(1);

    let job = await EmailQueue.findByPk(result.jobId);
    expect(job.attempts).toBe(1);
    expect(job.lastResponseCode).toBe(451);
    expect(job.lastResponse).toMatch(/Ratelimit exceeded/);
    expect(job.to).toBe(to); // le message est bien conservé, pas perdu

    // Avance de 30s (1er délai de backoff) → 2e tentative, qui réussit.
    await jest.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    job = await waitForNextAttempt(result.jobId, 1);

    expect(job.status).toBe("SENT");
    expect(job.attempts).toBe(2);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  test("429 persistant sur 5 tentatives → FAILED après le backoff complet, jamais rejeté, infos conservées", async () => {
    // 4 étapes de backoff, chacune avec jusqu'à 3s de polling réel → dépasse
    // le timeout par défaut de Jest (5s).
    sendMail.mockRejectedValue(smtpError(429, "Too Many Requests"));

    const to = emailFor("max-attempts");
    const result = await enqueueEmail({ to, subject: "Reset", text: "t", html: "<p>lien</p>" });
    createdJobIds.push(result.jobId);

    expect(result.status).toBe("RETRYING");
    expect(sendMail).toHaveBeenCalledTimes(1);

    // Traverse les 4 délais de backoff restants (30s, 1min, 2min, 5min),
    // en attendant à chaque étape que la tentative réelle se termine avant
    // d'avancer au délai suivant.
    let job = await EmailQueue.findByPk(result.jobId);
    for (const delay of RETRY_DELAYS_MS) {
      const before = job.attempts;
      await jest.advanceTimersByTimeAsync(delay);
      job = await waitForNextAttempt(result.jobId, before);
    }

    expect(job.status).toBe("FAILED");
    expect(job.attempts).toBe(MAX_ATTEMPTS);
    expect(sendMail).toHaveBeenCalledTimes(MAX_ATTEMPTS);

    // Conservé pour un renvoi manuel : sujet/destinataire/dernière erreur intacts.
    expect(job.to).toBe(to);
    expect(job.subject).toBe("Reset");
    expect(job.lastResponseCode).toBe(429);
  }, 20_000);

  test("554 (erreur permanente, ex: compte désactivé côté hébergeur) → FAILED dès la 1ère tentative, pas de retry gaspillé", async () => {
    sendMail.mockRejectedValueOnce(smtpError(554, "5.7.1 Disabled by user from hPanel"));

    const to = emailFor("permanent-error");
    const result = await enqueueEmail({ to, subject: "Reset", text: "t", html: "<p>lien</p>" });
    createdJobIds.push(result.jobId);

    expect(result.status).toBe("FAILED");
    expect(sendMail).toHaveBeenCalledTimes(1);

    const job = await EmailQueue.findByPk(result.jobId);
    expect(job.attempts).toBe(1);
    expect(job.lastResponseCode).toBe(554);

    // Aucune tentative supplémentaire même en avançant le temps.
    await jest.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
