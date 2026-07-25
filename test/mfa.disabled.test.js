"use strict";

// Tests du bypass complet MFA_ENABLED=false (voir config/mfaConfig.js) :
// authentification classique email+mot de passe, aucun OTP/EmailQueue MFA
// créé, /auth/mfa/verify et /auth/mfa/resend renvoient 404. Fixé
// explicitement ici (avant tout require) pour ne jamais dépendre de la
// valeur réelle du .env — voir test/mfa.test.js pour le pendant
// MFA_ENABLED=true.

process.env.MFA_ENABLED = "false";

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
const { sendMail } = require("../src/utils/mailer");

const RUN_ID = Date.now();
const emailFor = (label) => `mfa-disabled-${label}-${RUN_ID}@example.com`;
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

describe("MFA_ENABLED=false — bypass complet", () => {
  afterAll(async () => {
    await EmailQueue.destroy({ where: { userId: createdUserIds } });
    await MfaOtp.destroy({ where: { userId: createdUserIds } });
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  beforeEach(() => {
    sendMail.mockClear();
  });

  test("POST /auth/signin renvoie directement les JWT, sans champ mfaRequired, même pour un compte jamais vérifié", async () => {
    const email = emailFor("bypass");
    const user = await createTestUser(email);
    // mfaLastVerifiedAt=null : avec MFA_ENABLED=true, ce compte déclencherait
    // systématiquement un MFA (voir mfa.test.js "jamais vérifié"). Ici, non.
    expect(user.mfaLastVerifiedAt).toBeNull();

    const res = await request(app).post("/auth/signin").send({
      email, password: PASSWORD, deviceId: "device-bypass",
    });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("mfaRequired");
    expect(res.body).not.toHaveProperty("challengeToken");
    expect(res.body).not.toHaveProperty("expiresInSeconds");
    expect(typeof res.body.accessToken).toBe("string");
    expect(res.body.user.email).toBe(email);
  });

  test("aucun OTP ni job EmailQueue MFA n'est créé lors du signin", async () => {
    const email = emailFor("no-side-effects");
    const user = await createTestUser(email);

    await request(app).post("/auth/signin").send({
      email, password: PASSWORD, deviceId: "device-no-fx",
    });

    expect(await MfaOtp.count({ where: { userId: user.id } })).toBe(0);
    expect(await EmailQueue.count({ where: { userId: user.id, context: "mfa_otp" } })).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test("mfaLastVerifiedAt n'est ni lu ni modifié par le bypass", async () => {
    const email = emailFor("untouched-field");
    const user = await createTestUser(email);

    await request(app).post("/auth/signin").send({
      email, password: PASSWORD, deviceId: "device-untouched",
    });

    await user.reload();
    expect(user.mfaLastVerifiedAt).toBeNull(); // toujours null : jamais écrit par le bypass
  });

  test("POST /auth/mfa/verify renvoie 404", async () => {
    const res = await request(app).post("/auth/mfa/verify").send({
      challengeToken: "whatever", otp: "123456", deviceId: "device-x",
    });
    expect(res.status).toBe(404);
  });

  test("POST /auth/mfa/resend renvoie 404", async () => {
    const res = await request(app).post("/auth/mfa/resend").send({ challengeToken: "whatever" });
    expect(res.status).toBe(404);
  });
});
