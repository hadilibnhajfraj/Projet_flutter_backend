"use strict";

// Tests d'intégration du workflow MFA (POST /auth/signin avec second
// facteur, POST /auth/mfa/verify, POST /auth/mfa/resend, compatibilité avec
// POST /auth/reset-password). Même convention que
// test/auth.resetPassword.test.js : vraie base de dev, utilisateurs à email
// unique nettoyés en fin de suite, utils/mailer mocké (jamais de vrai envoi,
// le code OTP est extrait du HTML généré pour piloter le test).
//
// Cette suite teste le comportement MFA_ENABLED=true — fixé explicitement
// ici (avant tout require) pour ne jamais dépendre de la valeur réelle du
// .env (voir config/mfaConfig.js, et test/mfa.disabled.test.js pour le
// pendant MFA_ENABLED=false). dotenv ne réécrit jamais une variable déjà
// présente dans process.env, donc ceci prime sur le .env.
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
const TrustedDevice = require("../src/models/TrustedDevice");
const MfaAttemptLog = require("../src/models/MfaAttemptLog");
const { sendMail } = require("../src/utils/mailer");
const { generateResetToken } = require("../src/utils/passwordReset");

const RUN_ID = Date.now();
const emailFor = (label) => `mfa-test-${label}-${RUN_ID}@example.com`;
const PASSWORD = "StrongPass123!";

const createdUserIds = [];

async function createTestUser(email, opts = {}) {
  const user = await User.create({
    email,
    passwordHash: await bcrypt.hash(PASSWORD, 12),
    isActive: true,
    role: opts.role || "user",
    mfaLastVerifiedAt: opts.mfaLastVerifiedAt ?? null,
    lastLoginIp: opts.lastLoginIp ?? null,
    lastLoginBrowser: opts.lastLoginBrowser ?? null,
    lastLoginCountry: opts.lastLoginCountry ?? null,
    lastLoginDeviceId: opts.lastLoginDeviceId ?? null,
  });
  createdUserIds.push(user.id);
  return user;
}

// Extrait le code à 6 chiffres depuis le dernier email HTML "envoyé"
// (mock) — même esprit que lastEmailToken() dans auth.resetPassword.test.js.
function lastOtpCode() {
  const lastCall = sendMail.mock.calls[sendMail.mock.calls.length - 1][0];
  const match = lastCall.html.match(/>(\d{6})<\/span>/);
  return match ? match[1] : null;
}

function signin(email, deviceId, deviceToken) {
  return request(app)
    .post("/auth/signin")
    .send({ email, password: PASSWORD, deviceId, ...(deviceToken ? { deviceToken } : {}) });
}

function verify(challengeToken, otp, deviceId, extra = {}) {
  return request(app).post("/auth/mfa/verify").send({ challengeToken, otp, deviceId, ...extra });
}

describe("MFA (multi-factor authentication)", () => {
  afterAll(async () => {
    await MfaAttemptLog.destroy({ where: { userId: createdUserIds } });
    await MfaOtp.destroy({ where: { userId: createdUserIds } });
    await TrustedDevice.destroy({ where: { userId: createdUserIds } });
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  beforeEach(() => {
    sendMail.mockClear();
  });

  describe("POST /auth/signin — décision MFA", () => {
    test("jamais vérifié → MFA requis, aucune session ouverte, code envoyé par email", async () => {
      const email = emailFor("never-verified");
      await createTestUser(email);

      const res = await signin(email, "device-1");

      expect(res.status).toBe(200);
      expect(res.body.mfaRequired).toBe(true);
      expect(res.body.accessToken).toBeUndefined();
      expect(typeof res.body.challengeToken).toBe("string");
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0].subject).toBe("Votre code de vérification");
    });

    test("connexion récente, aucun changement de contexte → pas de MFA", async () => {
      const email = emailFor("recent");
      await createTestUser(email, { mfaLastVerifiedAt: new Date() });

      const res = await signin(email, "device-7");

      expect(res.status).toBe(200);
      expect(res.body.mfaRequired).toBe(false);
      expect(typeof res.body.accessToken).toBe("string");
      expect(sendMail).not.toHaveBeenCalled();
    });

    test("changement d'appareil force un MFA même si récemment vérifié", async () => {
      const email = emailFor("new-device");
      await createTestUser(email, { mfaLastVerifiedAt: new Date(), lastLoginDeviceId: "device-old" });

      const res = await signin(email, "device-new");
      expect(res.body.mfaRequired).toBe(true);
    });

    test("changement d'IP force un MFA même si récemment vérifié", async () => {
      const email = emailFor("new-ip");
      await createTestUser(email, { mfaLastVerifiedAt: new Date(), lastLoginIp: "1.2.3.4" });

      const res = await signin(email, "device-8");
      expect(res.body.mfaRequired).toBe(true);
    });

    test("rôle admin : fenêtre de 24h (30h d'ancienneté = MFA requis, contrairement à un utilisateur standard)", async () => {
      const email = emailFor("admin-24h");
      await createTestUser(email, {
        role: "admin",
        mfaLastVerifiedAt: new Date(Date.now() - 30 * 60 * 60 * 1000), // 30h : >24h (admin) mais <3j (standard)
        lastLoginDeviceId: "device-10",
      });

      const res = await signin(email, "device-10");
      expect(res.body.mfaRequired).toBe(true);
    });

    test("30h d'ancienneté pour un utilisateur standard → pas encore de MFA (fenêtre 3 jours)", async () => {
      const email = emailFor("standard-30h");
      await createTestUser(email, {
        role: "user",
        mfaLastVerifiedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
        lastLoginDeviceId: "device-10b",
      });

      const res = await signin(email, "device-10b");
      expect(res.body.mfaRequired).toBe(false);
    });
  });

  describe("POST /auth/mfa/verify", () => {
    test("code correct → session ouverte, mfaLastVerifiedAt et contexte mis à jour", async () => {
      const email = emailFor("verify-ok");
      await createTestUser(email);

      const res1 = await signin(email, "device-2");
      const otp = lastOtpCode();
      expect(otp).toMatch(/^\d{6}$/);

      const res2 = await verify(res1.body.challengeToken, otp, "device-2");

      expect(res2.status).toBe(200);
      expect(typeof res2.body.accessToken).toBe("string");
      expect(res2.body.mfaRequired).toBe(false);

      const user = await User.findOne({ where: { email } });
      expect(user.mfaLastVerifiedAt).not.toBeNull();
      expect(user.lastLoginDeviceId).toBe("device-2");
    });

    test("code incorrect → 400, compteur de tentatives décrémenté", async () => {
      const email = emailFor("verify-wrong");
      await createTestUser(email);
      const res1 = await signin(email, "device-3");
      const otp = lastOtpCode();
      const wrong = otp === "000000" ? "111111" : "000000";

      const res2 = await verify(res1.body.challengeToken, wrong, "device-3");

      expect(res2.status).toBe(400);
      expect(res2.body.reason).toBe("wrong_code");
      expect(res2.body.attemptsLeft).toBe(4);
    });

    test("5 tentatives incorrectes → max_attempts, puis même le bon code est refusé", async () => {
      const email = emailFor("max-attempts");
      await createTestUser(email);
      const res1 = await signin(email, "device-4");
      const otp = lastOtpCode();
      const wrong = otp === "000000" ? "111111" : "000000";

      for (let i = 0; i < 5; i++) {
        await verify(res1.body.challengeToken, wrong, "device-4");
      }

      const finalTry = await verify(res1.body.challengeToken, otp, "device-4");
      expect(finalTry.status).toBe(429);
      expect(finalTry.body.reason).toBe("max_attempts");
    }, 15000);

    test("code expiré → rejeté avec reason=expired", async () => {
      const email = emailFor("expired");
      const user = await createTestUser(email);
      const res1 = await signin(email, "device-5");
      const otp = lastOtpCode();

      const otpRow = await MfaOtp.findOne({ where: { userId: user.id }, order: [["createdAt", "DESC"]] });
      await otpRow.update({ expiresAt: new Date(Date.now() - 1000) });

      const res2 = await verify(res1.body.challengeToken, otp, "device-5");
      expect(res2.status).toBe(400);
      expect(res2.body.reason).toBe("expired");
    });

    test("challengeToken invalide → 401", async () => {
      const res = await verify("not-a-real-token", "123456", "device-x");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/mfa/resend", () => {
    test("renvoie un nouveau challengeToken et un nouveau code — l'ancien code cesse de fonctionner", async () => {
      const email = emailFor("resend");
      const user = await createTestUser(email);
      const res1 = await signin(email, "device-6");
      const oldOtp = lastOtpCode();

      // Le renvoi est soumis à un cooldown de 60s (voir test/mfa.dedup.test.js
      // pour la couverture dédiée de cette règle) — on simule ici son
      // écoulement pour tester spécifiquement la rotation du code/token.
      await user.update({ mfaLastSentAt: new Date(Date.now() - 61 * 1000) });

      const resendRes = await request(app)
        .post("/auth/mfa/resend")
        .send({ challengeToken: res1.body.challengeToken });

      expect(resendRes.status).toBe(200);
      expect(resendRes.body.challengeToken).not.toBe(res1.body.challengeToken);

      const newOtp = lastOtpCode();
      expect(newOtp).not.toBe(oldOtp);

      const failWithOld = await verify(resendRes.body.challengeToken, oldOtp, "device-6");
      expect(failWithOld.status).toBe(400);

      const okWithNew = await verify(resendRes.body.challengeToken, newOtp, "device-6");
      expect(okWithNew.status).toBe(200);
    });
  });

  describe("Faire confiance à cet appareil pendant 30 jours", () => {
    test("un appareil de confiance saute le MFA même si mfaLastVerifiedAt est périmé", async () => {
      const email = emailFor("trust-device");
      const user = await createTestUser(email);

      const res1 = await signin(email, "device-9");
      const otp = lastOtpCode();
      const verifyRes = await verify(res1.body.challengeToken, otp, "device-9", {
        trustDevice: true,
        deviceName: "Test Device",
      });

      expect(verifyRes.status).toBe(200);
      expect(typeof verifyRes.body.deviceToken).toBe("string");

      const trustedRow = await TrustedDevice.findOne({ where: { userId: user.id, deviceId: "device-9" } });
      expect(trustedRow).not.toBeNull();
      expect(trustedRow.revokedAt).toBeNull();

      // Périme volontairement la fenêtre "3 jours" — le device de confiance
      // doit quand même permettre de sauter le MFA.
      await user.update({ mfaLastVerifiedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });

      const res2 = await signin(email, "device-9", verifyRes.body.deviceToken);
      expect(res2.status).toBe(200);
      expect(res2.body.mfaRequired).toBe(false);
      expect(typeof res2.body.accessToken).toBe("string");
    });

    test("un device token présenté pour un AUTRE deviceId est ignoré (MFA toujours requis)", async () => {
      const email = emailFor("trust-device-mismatch");
      await createTestUser(email);

      const res1 = await signin(email, "device-A");
      const otp = lastOtpCode();
      const verifyRes = await verify(res1.body.challengeToken, otp, "device-A", { trustDevice: true });

      // Même token, mais deviceId différent dans la requête suivante.
      const res2 = await signin(email, "device-B", verifyRes.body.deviceToken);
      expect(res2.body.mfaRequired).toBe(true);
    });
  });

  describe("Compatibilité avec le flux Forgot Password / EmailQueue", () => {
    test("un reset password réussi révoque la confiance MFA (mfaLastVerifiedAt + appareils de confiance)", async () => {
      const email = emailFor("reset-invalidates");
      const user = await createTestUser(email, { mfaLastVerifiedAt: new Date(), lastLoginDeviceId: "device-11" });

      // Sanity check : sans reset, pas de MFA requis.
      const before = await signin(email, "device-11");
      expect(before.body.mfaRequired).toBe(false);

      const { token, tokenHash } = generateResetToken();
      await user.update({ resetPasswordTokenHash: tokenHash, resetPasswordExpiresAt: new Date(Date.now() + 60000) });

      const resetRes = await request(app)
        .post("/auth/reset-password")
        .send({ email, token, newPassword: "NewStrongPass456!" });
      expect(resetRes.status).toBe(200);

      await user.reload();
      expect(user.mfaLastVerifiedAt).toBeNull();

      const after = await request(app)
        .post("/auth/signin")
        .send({ email, password: "NewStrongPass456!", deviceId: "device-11" });
      expect(after.body.mfaRequired).toBe(true);
    });
  });
});
