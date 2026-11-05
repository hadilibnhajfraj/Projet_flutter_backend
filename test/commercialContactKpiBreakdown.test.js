"use strict";

// Dashboard « Commercial Contacts Analytics » : /my-kpi et /kpi renvoient les
// répartitions par commercial, par entreprise et par mois, calculées sur le
// MÊME périmètre que les totaux — comparées au SQL direct. Commercial = nom
// enregistré sur la fiche (user_nom_custom, sinon user_nom), jamais déduit.
// Base locale, lecture seule.

jest.mock("../src/utils/mailer", () => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "test" }), verifyConnection: jest.fn().mockResolvedValue({ ok: true }), maskEmail: (e) => e }));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));
jest.mock("../src/cron/rawMaterialRequestLate.job", () => ({}));

const request = require("supertest");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");

const PASSWORD = process.env.BACKOFFICE_PASSWORD;
const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });
const REP = `COALESCE(NULLIF(TRIM("user_nom_custom"::text), ''), NULLIF(TRIM("user_nom"::text), ''), 'Non assigné')`;

let INFO, AZIZ, ADMIN, BO;
let fingerprint;

async function account(email) {
  const [u] = await sql(`SELECT id, email, role::text AS role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte absent : ${email}`);
  return { user: u, auth: tokenFor(u) };
}

/** Attendus calculés en SQL direct sur un périmètre donné. */
async function expected(where, replacements) {
  const [tot] = await sql(`SELECT COUNT(*)::int AS contacts, COALESCE(SUM("nbAppels"),0)::int AS calls,
      COUNT(*) FILTER (WHERE statut = 'ok')::int AS actifs,
      COUNT(*) FILTER (WHERE statut IN ('client_refuse','user_injoignable'))::int AS "nonValides"
    FROM commercial_contacts ${where}`, replacements);
  const byRep = await sql(`SELECT ${REP} AS commercial, COUNT(*)::int AS contacts, COALESCE(SUM("nbAppels"),0)::int AS calls
    FROM commercial_contacts ${where} GROUP BY 1 ORDER BY 1`, replacements);
  const and = where ? `${where} AND` : "WHERE";
  const companies = await sql(`SELECT TRIM("nomSociete") AS "companyName", COUNT(*)::int AS "contactsCount", COALESCE(SUM("nbAppels"),0)::int AS "callsCount"
    FROM commercial_contacts ${and} NULLIF(TRIM("nomSociete"),'') IS NOT NULL GROUP BY 1 ORDER BY "contactsCount" DESC, "callsCount" DESC, "companyName" LIMIT 10`, replacements);
  const [{ n: withoutCompany }] = await sql(`SELECT COUNT(*)::int AS n FROM commercial_contacts ${and} NULLIF(TRIM("nomSociete"),'') IS NULL`, replacements);
  const months = await sql(`SELECT TO_CHAR(m, 'YYYY-MM') AS month,
      (SELECT COUNT(*)::int FROM commercial_contacts ${and} DATE_TRUNC('month', "createdAt") = m) AS "newContacts"
    FROM generate_series(DATE_TRUNC('month', NOW()) - INTERVAL '11 months', DATE_TRUNC('month', NOW()), INTERVAL '1 month') AS m ORDER BY m`, replacements);
  return { tot, byRep, companies, withoutCompany, months };
}

function checkAgainst(data, exp) {
  expect(data.totalContacts).toBe(exp.tot.contacts);
  expect(data.totalCalls).toBe(exp.tot.calls);
  expect([data.totalActifs, data.totalNonValides]).toEqual([exp.tot.actifs, exp.tot.nonValides]);
  // Contacts et appels par commercial : identiques au SQL, et aucun contact perdu.
  const reps = [...data.contactsByCommercial].map((r) => ({ commercial: r.commercial, contacts: r.contacts, calls: r.calls })).sort((a, b) => a.commercial.localeCompare(b.commercial));
  expect(reps).toEqual([...exp.byRep].sort((a, b) => a.commercial.localeCompare(b.commercial)));
  expect(data.contactsByCommercial.reduce((s, r) => s + r.contacts, 0)).toBe(exp.tot.contacts);
  expect(data.contactsByCommercial.reduce((s, r) => s + r.calls, 0)).toBe(exp.tot.calls);
  // Clés attendues par le modèle Flutter (CommercialCount / CompanyCount / MonthlyCount).
  for (const r of data.contactsByCommercial) expect(Object.keys(r).sort()).toEqual(["actifs", "calls", "commercial", "contacts", "entreprises", "nonValides"]);
  // Top entreprises : classement, noms réels (jamais vides), sommes = SQL.
  expect(data.topCompanies).toEqual(exp.companies);
  expect(data.topCompanies.every((c) => c.companyName.trim() !== "")).toBe(true);
  for (let i = 1; i < data.topCompanies.length; i++) expect(data.topCompanies[i - 1].contactsCount).toBeGreaterThanOrEqual(data.topCompanies[i].contactsCount);
  // Contacts sans entreprise : comptés à part, jamais une fausse entreprise.
  expect(data.contactsWithoutCompany).toBe(exp.withoutCompany);
  // 12 mois consécutifs jusqu'au mois courant : nouveaux contacts = SQL (date réelle de création).
  expect(data.monthlyActivity.map((m) => ({ month: m.month, newContacts: m.newContacts }))).toEqual(exp.months);
  // Aucun historique daté des appels : jamais de répartition inventée.
  expect(data.monthlyActivity.every((m) => m.callsCount === null)).toBe(true);
  expect(data.monthlyCallsAvailable).toBe(false);
  expect(data.monthlyCallsNote).toMatch(/nbAppels/);
}

beforeAll(async () => {
  [INFO, AZIZ, ADMIN] = await Promise.all([
    account("info@probardistribution.com"),
    account("aziz_nefzaoui@probardistribution.com"),
    account("cbitunisia@cbi-tunisia.com"),
  ]);
  _resetCache();
  if (PASSWORD) {
    const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
    expect(res.status).toBe(200);
    BO = { Authorization: `Bearer ${res.body.accessToken}` };
  }
  [fingerprint] = await sql(`SELECT COUNT(*)::int AS n, MAX("updatedAt") AS m FROM commercial_contacts`);
});

afterAll(async () => {
  const [after] = await sql(`SELECT COUNT(*)::int AS n, MAX("updatedAt") AS m FROM commercial_contacts`);
  expect(after).toEqual(fingerprint); // aucune donnée modifiée
  await sequelize.close();
});

describe("/my-kpi — répartitions sur le périmètre du compte", () => {
  test("compte info@ (référence du back-office) : commerciaux, appels, entreprises = SQL", async () => {
    const res = await request(app).get("/commercial-contacts/my-kpi").set(INFO.auth);
    expect(res.status).toBe(200);
    checkAgainst(res.body.data, await expected(`WHERE "createdBy" = :u`, { u: INFO.user.id }));
    expect(res.body.data.contactsByCommercial.length).toBeGreaterThan(1); // jamais un seul « info »
  });

  (PASSWORD ? test : test.skip)("back-office réel : même tableau de bord que son compte de référence (permissions inchangées)", async () => {
    const mine = await request(app).get("/commercial-contacts/my-kpi").set(BO);
    const ref = await request(app).get("/commercial-contacts/my-kpi").set(INFO.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual(ref.body.data);
  });

  test("autre commercial : uniquement ses propres contacts", async () => {
    const res = await request(app).get("/commercial-contacts/my-kpi").set(AZIZ.auth);
    expect(res.status).toBe(200);
    checkAgainst(res.body.data, await expected(`WHERE "createdBy" = :u`, { u: AZIZ.user.id }));
  });

  test("filtre ?commercialName=wajdi : même périmètre pour totaux et répartitions", async () => {
    const res = await request(app).get("/commercial-contacts/my-kpi?commercialName=wajdi").set(INFO.auth);
    expect(res.status).toBe(200);
    checkAgainst(res.body.data, await expected(`WHERE ("user_nom" = :c OR "user_nom_custom" = :c)`, { c: "wajdi" }));
  });
});

describe("/kpi — compte non administrateur : mêmes répartitions que /my-kpi", () => {
  test("commercial : /kpi = son périmètre, avec top entreprises et activité mensuelle", async () => {
    const res = await request(app).get("/commercial-contacts/kpi").set(AZIZ.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.isPersonalDashboard).toBe(true);
    checkAgainst(res.body.data, await expected(`WHERE "createdBy" = :u`, { u: AZIZ.user.id }));
  });

  (PASSWORD ? test : test.skip)("back-office réel : /kpi = périmètre de son compte de référence", async () => {
    const res = await request(app).get("/commercial-contacts/kpi").set(BO);
    expect(res.status).toBe(200);
    checkAgainst(res.body.data, await expected(`WHERE "createdBy" = :u`, { u: INFO.user.id }));
    expect(res.body.data.topCompanies.length).toBeGreaterThan(0);
  });
});

describe("/kpi — administrateur, périmètre global", () => {
  test("répartitions globales = SQL ; clés existantes conservées", async () => {
    const res = await request(app).get("/commercial-contacts/kpi").set(ADMIN.auth);
    expect(res.status).toBe(200);
    checkAgainst(res.body.data, await expected("", {}));
    for (const k of ["isPersonalDashboard", "totalCompanies", "totalCommercials", "contactsByStatus", "contactsByType", "topCommercials"]) {
      expect(res.body.data).toHaveProperty(k);
    }
  });
});
