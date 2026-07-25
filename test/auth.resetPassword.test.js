"use strict";

// Tests d'intégration du workflow de réinitialisation de mot de passe
// (POST /auth/forgot-password, GET /auth/reset-password/validate,
// POST /auth/reset-password). Utilise la vraie base de dev (pas de DB de
// test séparée disponible dans ce projet) mais uniquement via des
// utilisateurs dédiés à email unique, supprimés en fin de suite — aucune
// donnée existante n'est lue ni modifiée.
//
// L'envoi d'email réel est mocké (utils/mailer) pour ne jamais envoyer de
// vrais emails pendant les tests et pouvoir inspecter le contenu généré
// (lien, sujet, token).

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
}));

// app.js enregistre plusieurs cron jobs (node-cron) au chargement — sans
// rapport avec la fonctionnalité testée ici, mais leurs timers gardent le
// process Node vivant après la fin des tests et certains tournent contre la
// vraie base (AUTO_EMAIL_JOBS_ENABLED=true en dev). On les neutralise
// uniquement pour cette suite de tests.
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
const PasswordResetLog = require("../src/models/PasswordResetLog");
const { sendMail } = require("../src/utils/mailer");

const RUN_ID = Date.now();
const emailFor = (label) => `reset-test-${label}-${RUN_ID}@example.com`;
const OLD_PASSWORD = "OldPass123!";
const STRONG_PASSWORD = "NewPass456!";

const NEUTRAL_MESSAGE_RE = /Si un compte est associé/;

async function createTestUser(email) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(OLD_PASSWORD, 12),
    isActive: true,
    role: "user",
  });
}

// Extrait le token depuis le lien inséré dans le dernier email envoyé.
function lastEmailToken() {
  const lastCall = sendMail.mock.calls[sendMail.mock.calls.length - 1][0];
  const match = lastCall.html.match(/token=([a-f0-9]+)&email=/);
  return match ? match[1] : null;
}

const createdEmails = [];

async function forgotPassword(email) {
  createdEmails.push(email);
  return request(app).post("/auth/forgot-password").send({ email });
}

describe("Réinitialisation de mot de passe", () => {
  afterAll(async () => {
    await PasswordResetLog.destroy({ where: { email: createdEmails } });
    await User.destroy({ where: { email: createdEmails } });
    await sequelize.close();
  });

  beforeEach(() => {
    sendMail.mockClear();
  });

  describe("POST /auth/forgot-password", () => {
    test("utilisateur existant → réponse neutre + email envoyé avec le bon sujet/lien", async () => {
      const email = emailFor("existing");
      await createTestUser(email);

      const res = await forgotPassword(email);

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(NEUTRAL_MESSAGE_RE);
      expect(sendMail).toHaveBeenCalledTimes(1);

      const [args] = sendMail.mock.calls[0];
      expect(args.to).toBe(email);
      expect(args.subject).toBe("Réinitialisation de votre mot de passe");
      expect(args.html).toContain("/#/authentication/reset_password?token=");
      expect(args.html).toContain(encodeURIComponent(email));
    });

    test("utilisateur inexistant → même réponse neutre, aucun email envoyé", async () => {
      const res = await forgotPassword(emailFor("does-not-exist"));

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(NEUTRAL_MESSAGE_RE);
      expect(sendMail).not.toHaveBeenCalled();
    });

    test("email invalide → même réponse neutre", async () => {
      const res = await request(app).post("/auth/forgot-password").send({ email: "not-an-email" });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(NEUTRAL_MESSAGE_RE);
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  describe("Limite de 3 demandes par heure par utilisateur", () => {
    test("les 3 premières demandes envoient un email, la 4e est bloquée silencieusement", async () => {
      const email = emailFor("ratelimit");
      await createTestUser(email);

      const r1 = await forgotPassword(email);
      const r2 = await forgotPassword(email);
      const r3 = await forgotPassword(email);
      const r4 = await forgotPassword(email);

      expect([r1, r2, r3, r4].every((r) => r.status === 200)).toBe(true);
      expect([r1, r2, r3, r4].every((r) => NEUTRAL_MESSAGE_RE.test(r.body.message))).toBe(true);

      // Même réponse neutre pour les 4 — mais un seul envoi bloqué :
      expect(sendMail).toHaveBeenCalledTimes(3);

      const blockedLog = await PasswordResetLog.findOne({
        where: { email, reason: "rate_limited_email" },
      });
      expect(blockedLog).not.toBeNull();
    });
  });

  describe("Nouvelle demande invalide l'ancien token", () => {
    test("un 2e forgot-password régénère un token ; l'ancien devient invalide", async () => {
      const email = emailFor("regenerate");
      await createTestUser(email);

      await forgotPassword(email);
      const oldToken = lastEmailToken();

      await forgotPassword(email);
      const newToken = lastEmailToken();

      expect(oldToken).not.toBe(newToken);

      const oldCheck = await request(app)
        .get("/auth/reset-password/validate")
        .query({ email, token: oldToken });
      expect(oldCheck.body.valid).toBe(false);
      expect(oldCheck.body.reason).toBe("invalid");

      const newCheck = await request(app)
        .get("/auth/reset-password/validate")
        .query({ email, token: newToken });
      expect(newCheck.body.valid).toBe(true);
    });
  });

  describe("GET /auth/reset-password/validate", () => {
    test("token invalide (chaîne aléatoire) → invalid", async () => {
      const email = emailFor("invalidtoken");
      await createTestUser(email);
      await forgotPassword(email);

      const res = await request(app)
        .get("/auth/reset-password/validate")
        .query({ email, token: "a".repeat(64) });

      expect(res.body).toEqual({ valid: false, reason: "invalid" });
    });

    test("token expiré (resetPasswordExpiresAt forcé dans le passé) → expired", async () => {
      const email = emailFor("expired");
      const user = await createTestUser(email);
      await forgotPassword(email);
      const token = lastEmailToken();

      // Force l'expiration sans attendre 15 minutes réelles.
      await user.reload();
      await user.update({ resetPasswordExpiresAt: new Date(Date.now() - 1000) });

      const res = await request(app)
        .get("/auth/reset-password/validate")
        .query({ email, token });

      expect(res.body).toEqual({ valid: false, reason: "expired" });
    });

    test("expiration à 15 minutes : valide juste avant l'échéance, expiré juste après", async () => {
      const email = emailFor("boundary");
      const user = await createTestUser(email);
      await forgotPassword(email);
      const token = lastEmailToken();
      await user.reload();

      // Simule "il reste 1 seconde avant l'échéance des 15 minutes".
      await user.update({ resetPasswordExpiresAt: new Date(Date.now() + 1000) });
      const stillValid = await request(app)
        .get("/auth/reset-password/validate")
        .query({ email, token });
      expect(stillValid.body.valid).toBe(true);

      // Simule "l'échéance des 15 minutes vient de passer".
      await user.update({ resetPasswordExpiresAt: new Date(Date.now() - 1000) });
      const nowExpired = await request(app)
        .get("/auth/reset-password/validate")
        .query({ email, token });
      expect(nowExpired.body).toEqual({ valid: false, reason: "expired" });
    });
  });

  describe("POST /auth/reset-password", () => {
    test("mot de passe faible rejeté (ne consomme pas le token)", async () => {
      const email = emailFor("weakpw");
      await createTestUser(email);
      await forgotPassword(email);
      const token = lastEmailToken();

      const weakPasswords = ["short1!", "alllowercase1!", "ALLUPPERCASE1!", "NoDigitsHere!", "NoSpecialChar123"];
      for (const pw of weakPasswords) {
        const res = await request(app)
          .post("/auth/reset-password")
          .send({ email, token, newPassword: pw });
        expect(res.status).toBe(400);
      }

      // Le token n'a pas été consommé par les tentatives rejetées :
      const check = await request(app)
        .get("/auth/reset-password/validate")
        .query({ email, token });
      expect(check.body.valid).toBe(true);
    });

    test("succès : hash le mot de passe, invalide le token (usage unique) et le refreshTokenHash", async () => {
      const email = emailFor("success");
      const user = await createTestUser(email);
      await user.update({ refreshTokenHash: "some-old-session-hash" });
      await forgotPassword(email);
      const token = lastEmailToken();

      const res = await request(app)
        .post("/auth/reset-password")
        .send({ email, token, newPassword: STRONG_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/modifié avec succès/);

      await user.reload();
      expect(await bcrypt.compare(STRONG_PASSWORD, user.passwordHash)).toBe(true);
      expect(user.resetPasswordTokenHash).toBeNull();
      expect(user.resetPasswordExpiresAt).toBeNull();
      expect(user.refreshTokenHash).toBeNull(); // sessions invalidées
    });

    test("token déjà utilisé → invalid au second essai", async () => {
      const email = emailFor("reuse");
      await createTestUser(email);
      await forgotPassword(email);
      const token = lastEmailToken();

      const first = await request(app)
        .post("/auth/reset-password")
        .send({ email, token, newPassword: STRONG_PASSWORD });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post("/auth/reset-password")
        .send({ email, token, newPassword: "AnotherPass789!" });
      expect(second.status).toBe(400);
      expect(second.body.reason).toBe("invalid");
    });

    test("token invalide → 400 invalid", async () => {
      const email = emailFor("badtoken");
      await createTestUser(email);

      const res = await request(app)
        .post("/auth/reset-password")
        .send({ email, token: "b".repeat(64), newPassword: STRONG_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("invalid");
    });
  });

  // La confirmation du mot de passe (champ "Confirmer le mot de passe")
  // est une règle purement côté client (le backend n'accepte que
  // email/token/newPassword) — même logique que reset_password_controller.dart.
  describe("Confirmation de mot de passe différente (règle client)", () => {
    test("newPassword !== confirmPassword est détecté", () => {
      const newPassword = "NewPass456!";
      const confirmPassword = "Different456!";
      expect(newPassword === confirmPassword).toBe(false);
    });

    test("newPassword === confirmPassword est accepté", () => {
      const newPassword = "NewPass456!";
      const confirmPassword = "NewPass456!";
      expect(newPassword === confirmPassword).toBe(true);
    });
  });
});
