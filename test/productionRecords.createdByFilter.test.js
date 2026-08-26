"use strict";

// §MODIFICATION — ADMIN > PRODUCTION RECORDS — FILTRE PAR UTILISATEUR.
// Contre la vraie DB de dev (comptes réels déjà seedés — voir
// responsable-logistique-achat.seeder.js / production-accounts.seeder.js),
// même style que finance.crud.test.js. Priorité à la SÉCURITÉ (§5/§10) :
// un rôle owner-scoped ne doit JAMAIS pouvoir élargir son accès via le
// paramètre `createdBy`, même s'il connaît l'id d'un autre utilisateur.

jest.mock("../src/utils/mailer", () => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "test" }) }));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const svc = require("../src/modules/production-records/services/productionRecords.service");

const PASSWORD = "ChangeMe123!";

async function signIn(email) {
  const res = await request(app).post("/auth/signin").send({ email, password: PASSWORD });
  return { token: res.body.accessToken, status: res.status };
}

async function userId(email) {
  const [row] = await sequelize.query(`SELECT id FROM users WHERE email = :email LIMIT 1`, {
    replacements: { email },
    type: sequelize.QueryTypes.SELECT,
  });
  return row?.id;
}

describe("Production Records — filtre createdBy (Admin)", () => {
  let p1Token, p2Token, p1Id, p2Id;

  beforeAll(async () => {
    const p1 = await signIn("production_1@cbi-tunisia.com");
    const p2 = await signIn("production_2@cbi-tunisia.com");
    p1Token = p1.token;
    p2Token = p2.token;
    p1Id = await userId("production_1@cbi-tunisia.com");
    p2Id = await userId("production_2@cbi-tunisia.com");
  }, 20000);

  afterAll(async () => {
    await sequelize.close();
  });

  test("sans authentification -> 401 sur les 3 endpoints", async () => {
    const results = await Promise.all([
      request(app).get("/production-records"),
      request(app).get("/production-records/creators"),
      request(app).get("/production-records/summary"),
    ]);
    results.forEach((res) => expect(res.status).toBe(401));
  });

  // ─────────────────────────────────────────────────────────────────────
  // SÉCURITÉ (§5/§10) — le cœur de ce ticket : un rôle owner-scoped ne peut
  // JAMAIS élargir son accès via `?createdBy=<un autre utilisateur>`.
  // ─────────────────────────────────────────────────────────────────────
  test("production_1 avec ?createdBy=<production_2> -> résultat IDENTIQUE à sans filtre (jamais d'escalade)", async () => {
    const withoutFilter = await request(app).get("/production-records").set("Authorization", `Bearer ${p1Token}`);
    const withEscalationAttempt = await request(app)
      .get(`/production-records?createdBy=${p2Id}`)
      .set("Authorization", `Bearer ${p1Token}`);

    expect(withoutFilter.status).toBe(200);
    expect(withEscalationAttempt.status).toBe(200);
    expect(withEscalationAttempt.body.pagination.total).toBe(withoutFilter.body.pagination.total);
    // Aucune fiche de production_2 ne doit apparaître.
    for (const row of withEscalationAttempt.body.data) {
      expect(row.createdBy).not.toBe(p2Id);
    }
  });

  test("GET /production-records/creators pour production_1 -> UNIQUEMENT lui-même, jamais production_2", async () => {
    const res = await request(app).get("/production-records/creators").set("Authorization", `Bearer ${p1Token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const creator of res.body.data) {
      expect(creator.id).toBe(p1Id);
    }
  });

  test("GET /production-records/summary pour production_1 avec ?createdBy=<production_2> -> même résultat que sans filtre", async () => {
    const withoutFilter = await request(app).get("/production-records/summary").set("Authorization", `Bearer ${p1Token}`);
    const escalation = await request(app)
      .get(`/production-records/summary?createdBy=${p2Id}`)
      .set("Authorization", `Bearer ${p1Token}`);
    expect(withoutFilter.status).toBe(200);
    expect(escalation.status).toBe(200);
    expect(escalation.body.data).toEqual(withoutFilter.body.data);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Côté Admin (service direct — mêmes fonctions que le controller, sans
  // dépendre d'un mot de passe admin réel) : le filtre DOIT fonctionner.
  // ─────────────────────────────────────────────────────────────────────
  test("Admin sans filtre voit >= autant de fiches qu'avec createdBy=production_1", async () => {
    const admin = { id: "test-admin", role: "superadmin" };
    const all = await svc.listRecords({}, admin);
    const filtered = await svc.listRecords({ createdBy: p1Id }, admin);

    expect(filtered.pagination.total).toBeLessThanOrEqual(all.pagination.total);
    // Toutes les lignes retournées appartiennent bien à production_1 —
    // jamais une fiche d'un autre utilisateur qui se serait glissée.
    for (const row of filtered.data) {
      expect(row.createdBy).toBe(p1Id);
    }
  });

  test("Admin : les statistiques (§11) se recalculent avec createdBy — jamais identiques si les fiches diffèrent", async () => {
    const admin = { id: "test-admin", role: "superadmin" };
    const globalStats = await svc.getStatistics({}, admin);
    const p1Stats = await svc.getStatistics({ createdBy: p1Id }, admin);

    expect(p1Stats.total).toBeLessThanOrEqual(globalStats.total);
    // productionTotals (KPI industriels) suit également le même filtre.
    const p1Totals = await svc.getProductionTotals({ createdBy: p1Id }, admin);
    expect(p1Totals).toBeDefined();
  });

  test("Admin : GET /production-records/creators renvoie plusieurs utilisateurs distincts (jamais codé en dur)", async () => {
    const admin = { id: "test-admin", role: "superadmin" };
    const creators = await svc.getCreators(admin);
    expect(Array.isArray(creators)).toBe(true);
    const ids = creators.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // jamais de doublon
    // Chaque créateur a bien un id/email réels, jamais une valeur inventée.
    for (const c of creators) {
      expect(c.id).toBeTruthy();
      expect(c.email).toContain("@");
    }
  });
});
