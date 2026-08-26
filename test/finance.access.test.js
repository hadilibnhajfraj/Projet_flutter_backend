"use strict";

// Accès au module Finance (§18 du cahier des charges) : finance_probar est
// autorisé sur /finance/*, refusé sur un autre module (moduleAccessGuard) ;
// un rôle non-Finance est refusé sur /finance/* (requireRole) ; toute
// requête non authentifiée est refusée. Même squelette que
// test/mfa.disabled.test.js (mocks cron/mailer, DB réelle, fixtures
// uniques, nettoyage en afterAll).

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

const RUN_ID = Date.now();
const PASSWORD = "StrongPass123!";
const createdUserIds = [];

async function createTestUser(role) {
  const user = await User.create({
    email: `finance-access-${role}-${RUN_ID}@example.com`,
    passwordHash: await bcrypt.hash(PASSWORD, 12),
    isActive: true,
    role,
  });
  createdUserIds.push(user.id);
  return user;
}

async function signIn(email) {
  const res = await request(app).post("/auth/signin").send({ email, password: PASSWORD });
  return res.body.accessToken;
}

describe("Finance — accès par rôle", () => {
  let financeToken;
  let userToken;

  // 2x bcrypt.hash (création) + 2x signin (bcrypt.compare) à coût 12 — chacun
  // ~700-800ms sur cette machine, soit un total déjà proche du timeout par
  // défaut de Jest (5000ms) rien qu'en fonctionnement normal ; une charge
  // système même légère le dépasse. Timeout explicite plus large, purement
  // pour la fiabilité du hook — ne change aucun comportement testé.
  beforeAll(async () => {
    const financeUser = await createTestUser("finance_probar");
    const plainUser = await createTestUser("user");
    financeToken = await signIn(financeUser.email);
    userToken = await signIn(plainUser.email);
  }, 20000);

  afterAll(async () => {
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  test.each([
    "/finance/dashboard",
    "/finance/dashboard/monthly",
    "/finance/raw-materials",
    "/finance/shipments",
    "/finance/invoices",
    "/finance/paid-invoices",
  ])("finance_probar reçoit 200 sur GET %s", async (path) => {
    const res = await request(app).get(path).set("Authorization", `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("finance_probar reçoit 403 sur un autre module (moduleAccessGuard)", async () => {
    const res = await request(app).get("/por-promesh").set("Authorization", `Bearer ${financeToken}`);
    expect(res.status).toBe(403);
  });

  test("un rôle non-Finance reçoit 403 sur /finance/dashboard (requireRole)", async () => {
    const res = await request(app).get("/finance/dashboard").set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  test("une requête non authentifiée reçoit 401 sur /finance/dashboard", async () => {
    const res = await request(app).get("/finance/dashboard");
    expect(res.status).toBe(401);
  });
});
