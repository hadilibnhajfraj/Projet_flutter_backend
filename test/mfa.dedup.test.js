"use strict";

// Tests de la robustesse anti-doublon du MFA (double-clic, requêtes
// concurrentes, cooldown de renvoi, réutilisation d'un OTP/job encore
// actif). Même convention que test/mfa.test.js : vraie base de dev,
// utilisateurs à email unique, utils/mailer mocké.
//
// Fixe explicitement MFA_ENABLED=true (voir test/mfa.test.js pour le détail
// — ne dépend jamais de la valeur réelle du .env).
process.env.MFA_ENABLED = "true";

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
}));

jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const bcrypt = require("bcrypt");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");
const MfaOtp = require("../src/models/MfaOtp");
const EmailQueue = require("../src/models/EmailQueue");
const MfaAttemptLog = require("../src/models/MfaAttemptLog");
const { sendMail } = require("../src/utils/mailer");

const RUN_ID = Date.now();
const emailFor = (label) => `mfa-dedup-${label}-${RUN_ID}@example.com`;
const PASSWORD = "StrongPass123!";

const createdUserIds = [];

async function createTestUser(email) {
  const user = await User.create({
    email,
    passwordHash: await bcrypt.hash(PASSWORD, 12),
    isActive: true,
    role: "user",
  });
  createdUserIds.push(user.id);
  return user;
}

function signin(email, deviceId) {
  return request(app).post("/auth/signin").send({ email, password: PASSWORD, deviceId });
}

function countOtpRows(userId) {
  return MfaOtp.count({ where: { userId } });
}

describe("MFA — anti-doublon (double-clic, concurrence, cooldown)", () => {
  afterAll(async () => {
    await MfaAttemptLog.destroy({ where: { userId: createdUserIds } });
    await EmailQueue.destroy({ where: { userId: createdUserIds } });
    await MfaOtp.destroy({ where: { userId: createdUserIds } });
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  beforeEach(() => {
    sendMail.mockClear();
  });

  test("double-clic sur 'Se connecter' → un seul email envoyé, un seul OTP créé", async () => {
    const email = emailFor("double-click");
    const user = await createTestUser(email);

    const res1 = await signin(email, "device-1");
    const res2 = await signin(email, "device-1");

    expect(res1.body.mfaRequired).toBe(true);
    expect(res2.body.mfaRequired).toBe(true);
    expect(res2.body.message).toMatch(/déjà été envoyé/);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(await countOtpRows(user.id)).toBe(1);
  });

  test("5 requêtes simultanées → un seul OTP créé, un seul email envoyé", async () => {
    const email = emailFor("concurrent-5");
    const user = await createTestUser(email);

    const results = await Promise.all([
      signin(email, "device-c"),
      signin(email, "device-c"),
      signin(email, "device-c"),
      signin(email, "device-c"),
      signin(email, "device-c"),
    ]);

    expect(results.every((r) => r.body.mfaRequired === true)).toBe(true);
    expect(await countOtpRows(user.id)).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  }, 20000);

  test("OTP encore actif (>30s restantes) → signin répété ne renvoie pas d'email", async () => {
    const email = emailFor("otp-active");
    const user = await createTestUser(email);

    await signin(email, "device-2");
    expect(sendMail).toHaveBeenCalledTimes(1);

    const res2 = await signin(email, "device-2");
    expect(res2.body.mfaRequired).toBe(true);
    expect(res2.body.message).toMatch(/déjà été envoyé/);
    expect(sendMail).toHaveBeenCalledTimes(1); // toujours 1, pas 2
    expect(await countOtpRows(user.id)).toBe(1);
  });

  test("un job EmailQueue déjà actif pour cet utilisateur → aucun nouveau job ni OTP créé", async () => {
    const email = emailFor("queue-exists");
    const user = await createTestUser(email);

    // Simule un envoi précédent encore en cours de retry (ex: 451 Hostinger),
    // sans OTP actif correspondant (cas limite couvert séparément par la
    // vérification EmailQueue, indépendamment de la vérification OTP).
    await EmailQueue.create({
      to: email,
      subject: "Votre code de vérification",
      text: "t",
      html: "<p>t</p>",
      context: "mfa_otp",
      userId: user.id,
      status: "RETRYING",
      attempts: 1,
      maxAttempts: 5,
      nextAttemptAt: new Date(Date.now() + 30000),
    });

    const res = await signin(email, "device-3");

    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.message).toMatch(/déjà été envoyé/);
    expect(sendMail).not.toHaveBeenCalled();
    expect(await countOtpRows(user.id)).toBe(0); // aucun OTP créé tant que le job existant est actif

    const jobCount = await EmailQueue.count({ where: { userId: user.id, context: "mfa_otp" } });
    expect(jobCount).toBe(1); // toujours un seul job, pas un deuxième
  });

  describe("POST /auth/mfa/resend", () => {
    test("avant 60s depuis le dernier envoi → HTTP 429", async () => {
      const email = emailFor("resend-too-soon");
      await createTestUser(email);

      const res1 = await signin(email, "device-4");
      sendMail.mockClear();

      const resendRes = await request(app)
        .post("/auth/mfa/resend")
        .send({ challengeToken: res1.body.challengeToken });

      expect(resendRes.status).toBe(429);
      expect(resendRes.body.reason).toBe("cooldown_active");
      expect(typeof resendRes.body.retryAfterSeconds).toBe("number");
      expect(sendMail).not.toHaveBeenCalled();
    });

    test("après 60s depuis le dernier envoi → nouvel email envoyé", async () => {
      const email = emailFor("resend-after-cooldown");
      const user = await createTestUser(email);

      const res1 = await signin(email, "device-5");
      expect(sendMail).toHaveBeenCalledTimes(1);

      // Simule l'écoulement du cooldown de 60s sans attendre réellement.
      await user.update({ mfaLastSentAt: new Date(Date.now() - 61 * 1000) });

      const resendRes = await request(app)
        .post("/auth/mfa/resend")
        .send({ challengeToken: res1.body.challengeToken });

      expect(resendRes.status).toBe(200);
      expect(sendMail).toHaveBeenCalledTimes(2);
      expect(await countOtpRows(user.id)).toBe(2); // l'ancien OTP + le nouveau (historique conservé)
    });
  });

  test("validation MFA réussie → otpHash/expiresAt effacés, job EmailQueue résiduel annulé", async () => {
    const email = emailFor("cleanup");
    const user = await createTestUser(email);

    const res1 = await signin(email, "device-6");
    const lastCall = sendMail.mock.calls[sendMail.mock.calls.length - 1][0];
    const otp = lastCall.html.match(/>(\d{6})<\/span>/)[1];

    // Simule un job encore RETRYING au moment de la validation (ex: le
    // premier envoi a échoué en 451 et est en attente de nouvel essai).
    const otpRow = await MfaOtp.findOne({ where: { userId: user.id }, order: [["createdAt", "DESC"]] });
    const staleJob = await EmailQueue.create({
      to: email,
      subject: "Votre code de vérification",
      text: "t",
      html: "<p>t</p>",
      context: "mfa_otp",
      userId: user.id,
      status: "RETRYING",
      attempts: 1,
      maxAttempts: 5,
      nextAttemptAt: new Date(Date.now() + 30000),
    });

    const verifyRes = await request(app)
      .post("/auth/mfa/verify")
      .send({ challengeToken: res1.body.challengeToken, otp, deviceId: "device-6" });

    expect(verifyRes.status).toBe(200);

    await otpRow.reload();
    expect(otpRow.consumedAt).not.toBeNull();
    expect(otpRow.otpHash).toBeNull();
    expect(otpRow.expiresAt).toBeNull();

    await staleJob.reload();
    expect(staleJob.status).toBe("CANCELLED");
  });
});
