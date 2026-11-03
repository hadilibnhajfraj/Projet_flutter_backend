"use strict";

// Module Production — compte back-office en CONSULTATION GLOBALE (config/
// backofficeReadOnly.js, PRODUCTION_READ_PREFIXES ; permission production.read_all,
// config/rolePermissions.js).
// Contre la base de DÉVELOPPEMENT locale, données existantes uniquement :
// rien n'est créé, modifié ni supprimé (vérifié à la fin).
// Back-office : connexion RÉELLE (BACKOFFICE_PASSWORD), jamais affichée.

jest.mock("../src/utils/mailer", () => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "test" }), verifyConnection: jest.fn().mockResolvedValue({ ok: true }), maskEmail: (e) => e }));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));

const request = require("supertest");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");

const PASSWORD = process.env.BACKOFFICE_PASSWORD;
const describeIfPassword = PASSWORD ? describe : describe.skip;
const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });
// Liste des fiches : `id` composite « promesh:<uuid> » / « probar:<uuid> ».
const sortIds = (rows) => rows.map((r) => String(r.id).replace(/^(promesh|probar):/, "")).sort();

// Fiches listées (non archivées — règle existante de la liste, tous rôles).
const SQL_LINES = {
  promesh: { table: "por_promesh", notArchived: `status::text <> 'ARCHIVED'`, date: `"dateProduction"` },
  probar: { table: "industrial_records", notArchived: `module = 'probar' AND statut::text <> 'archivee'`, date: `"dateFiche"` },
};

let BO;
let ADMIN;
let PROD1;
let PROD2;
let INFO;
let snapshot;

async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte absent : ${email}`);
  return { user: u, auth: tokenFor(u) };
}

const fiches = (auth, type, qs = "") => request(app).get(`/production-records/fiches?type=${type}&limit=100${qs}`).set(auth);
const sqlFicheIds = async (type, extra = "", r = {}) =>
  (await sql(`SELECT id FROM ${SQL_LINES[type].table} WHERE ${SQL_LINES[type].notArchived} ${extra}`, r)).map((x) => String(x.id)).sort();

async function fingerprint() {
  return sql(`SELECT
      (SELECT COUNT(*)::int FROM por_promesh) promesh, (SELECT MAX("updatedAt") FROM por_promesh) promesh_m,
      (SELECT COUNT(*)::int FROM por_promesh WHERE status::text = 'ARCHIVED') promesh_archived,
      (SELECT COUNT(*)::int FROM industrial_records WHERE statut::text = 'archivee') probar_archived,
      (SELECT COUNT(*)::int FROM industrial_records) probar, (SELECT MAX("updatedAt") FROM industrial_records) probar_m,
      (SELECT COUNT(*)::int FROM por_promesh_attachments) attachments`);
}

beforeAll(async () => {
  [ADMIN, PROD1, PROD2, INFO] = await Promise.all([
    account("cbitunisia@cbi-tunisia.com"),
    account("production_1@cbi-tunisia.com"),
    account("production_2@cbi-tunisia.com"),
    account("info@probardistribution.com"),
  ]);
  _resetCache();
  if (PASSWORD) {
    const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
    expect(res.status).toBe(200);
    BO = { Authorization: `Bearer ${res.body.accessToken}` };
  }
  snapshot = await fingerprint();
});

afterAll(async () => {
  expect(await fingerprint()).toEqual(snapshot); // aucune donnée de production modifiée
  await sequelize.close();
});

describeIfPassword("Production — back-office en consultation globale", () => {
  test("1. toutes les fiches PROBAR (liste = SQL = vue administrateur)", async () => {
    const res = await fiches(BO, "probar");
    expect(res.status).toBe(200);
    expect(sortIds(res.body.data)).toEqual(await sqlFicheIds("probar"));
    expect(sortIds(res.body.data)).toEqual(sortIds((await fiches(ADMIN.auth, "probar")).body.data));
    const legacy = await request(app).get("/industrial-records").set(BO);
    expect(legacy.status).toBe(200);
  });

  test("2. toutes les fiches PROMESH 1, 2, 3 et 4", async () => {
    const all = await fiches(BO, "promesh");
    expect(sortIds(all.body.data)).toEqual(await sqlFicheIds("promesh"));
    for (const m of ["1", "2", "3", "4"]) {
      const res = await fiches(BO, "promesh", `&machine=${m}`);
      expect(res.status).toBe(200);
      expect([m, sortIds(res.body.data)]).toEqual([m, await sqlFicheIds("promesh", `AND machine::text = :m`, { m })]);
    }
    expect((await request(app).get("/por-promesh").set(BO)).status).toBe(200);
  });

  test("3-4. fiches créées par PROD1 et par PROD2 : détail complet, vrai créateur", async () => {
    for (const prod of [PROD1, PROD2]) {
      const [p] = await sql(`SELECT id, status::text status, "updatedAt" FROM por_promesh WHERE "createdBy" = :u ORDER BY id LIMIT 1`, { u: prod.user.id });
      const res = await request(app).get(`/por-promesh/${p.id}`).set(BO);
      expect([prod.user.email, res.status]).toEqual([prod.user.email, 200]);
      expect(res.body.data.createdBy).toBe(prod.user.id);
      // Même détail que l'administrateur (aucun champ ajouté ni masqué).
      expect(res.body).toEqual((await request(app).get(`/por-promesh/${p.id}`).set(ADMIN.auth)).body);
      // Lecture sans effet sur la fiche (y compris une fiche archivée).
      expect((await sql(`SELECT id, status::text status, "updatedAt" FROM por_promesh WHERE id = :id`, { id: p.id }))[0]).toEqual(p);
      const [b] = await sql(`SELECT id FROM industrial_records WHERE module = 'probar' AND "createdBy" = :u ORDER BY id LIMIT 1`, { u: prod.user.id });
      if (b) {
        const r = await request(app).get(`/industrial-records/${b.id}`).set(BO);
        expect(r.status).toBe(200);
        expect(r.body).toEqual((await request(app).get(`/industrial-records/${b.id}`).set(ADMIN.auth)).body);
      }
    }
  });

  test("5. fiches des deux équipes (Matin et Nuit)", async () => {
    for (const type of ["promesh", "probar"]) {
      for (const poste of ["matin", "nuit"]) {
        const res = await fiches(BO, type, `&poste=${poste}`);
        expect([type, poste, sortIds(res.body.data)]).toEqual([type, poste, await sqlFicheIds(type, `AND poste::text = :poste`, { poste })]);
      }
    }
  });

  test("6. fiches validées, refusées et non soumises (validation et saisie)", async () => {
    const res = await fiches(BO, "promesh");
    const adm = await fiches(ADMIN.auth, "promesh");
    expect(res.body.summary).toEqual(adm.body.summary);
    const states = new Set(res.body.data.map((r) => `${r.saisie}/${r.approval?.status ?? "none"}`));
    expect(states.size).toBeGreaterThan(1);
    const [rejected] = await sql(`SELECT id FROM por_promesh WHERE "approvalStatus" = 'REJECTED' LIMIT 1`);
    if (rejected) {
      const d = await request(app).get(`/production-fiche-approvals/promesh/${rejected.id}`).set(BO);
      expect(d.status).toBe(200);
      expect(Array.isArray(d.body.data.history)).toBe(true); // historique de validation
      expect([d.body.data.canDecide, d.body.data.canResubmit]).toEqual([false, false]);
    }
  });

  test("7. paramètres de production et contrôle qualité : vue centralisée identique à l'administrateur", async () => {
    const list = await request(app).get("/production-records?limit=5").set(BO);
    expect(list.status).toBe(200);
    expect(list.body).toEqual((await request(app).get("/production-records?limit=5").set(ADMIN.auth)).body);
    const first = (list.body.data || [])[0];
    if (first) {
      const d = await request(app).get(`/production-records/${first.id}`).set(BO);
      expect(d.status).toBe(200);
      expect(d.body).toEqual((await request(app).get(`/production-records/${first.id}`).set(ADMIN.auth)).body);
    }
  });

  test("8. documents : rapport PDF d'une fiche PROMESH téléchargeable", async () => {
    const [p] = await sql(`SELECT id FROM por_promesh ORDER BY id LIMIT 1`);
    const res = await request(app).get(`/por-promesh/${p.id}/pdf`).set(BO).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });

  test("9. filtres date, machine et équipe combinés", async () => {
    const [{ d }] = await sql(`SELECT MAX("dateProduction")::text d FROM por_promesh WHERE status::text <> 'ARCHIVED'`);
    const res = await fiches(BO, "promesh", `&period=custom&startDate=${d}&endDate=${d}&machine=1&poste=matin`);
    expect(res.status).toBe(200);
    expect(sortIds(res.body.data)).toEqual(await sqlFicheIds("promesh", `AND "dateProduction" = :d AND machine::text = '1' AND poste::text = 'matin'`, { d }));
    const c = await request(app).get(`/production-records/creators`).set(BO);
    expect(c.status).toBe(200);
    expect(c.body).toEqual((await request(app).get(`/production-records/creators`).set(ADMIN.auth)).body);
  });

  test("10. récapitulatifs PROBAR et PROMESH : mêmes totaux que l'administrateur", async () => {
    for (const type of ["probar", "promesh"]) {
      const res = await request(app).get(`/production-records/summary?type=${type}&period=all`).set(BO);
      expect([type, res.status]).toEqual([type, 200]);
      expect(res.body).toEqual((await request(app).get(`/production-records/summary?type=${type}&period=all`).set(ADMIN.auth)).body);
    }
    for (const path of ["/production-records/filters", "/production-records/dashboard", "/por-promesh/stats", "/por-promesh/dashboard"]) {
      const res = await request(app).get(path).set(BO);
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  test("11. création, modification, suppression, validation, pièces jointes : refusées par le backend", async () => {
    const [p] = await sql(`SELECT id FROM por_promesh ORDER BY id LIMIT 1`);
    const [b] = await sql(`SELECT id FROM industrial_records WHERE module = 'probar' ORDER BY id LIMIT 1`);
    const writes = [
      ["post", "/por-promesh", { machine: "1" }],
      ["post", "/por-promesh/new", { machine: "1", poste: "matin" }],
      ["put", `/por-promesh/${p.id}`, { observationsGenerales: "x" }],
      ["delete", `/por-promesh/${p.id}`],
      ["post", `/por-promesh/${p.id}/validate`, {}],
      ["post", `/por-promesh/${p.id}/attachments`, {}],
      ["post", "/industrial-records", { machine: "1" }],
      ["put", `/industrial-records/${b.id}`, { observations: "x" }],
      ["delete", `/industrial-records/${b.id}`],
      ["post", `/production-fiche-approvals/promesh/${p.id}/approve`, {}],
      ["post", `/production-fiche-approvals/promesh/${p.id}/reject`, { comment: "refus de test" }],
      ["post", `/production-fiche-approvals/probar/${b.id}/resubmit`, {}],
      ["post", "/production-draft-archive/requests", {}],
      ["post", "/quality-control", {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await request(app)[method](path).set(BO).send(body);
      expect([method, path, res.status, res.body.code]).toEqual([method, path, 403, "READ_ONLY_ACCOUNT"]);
    }
    // File de validation (module Validation) : non ouverte au back-office.
    for (const path of ["/production-fiche-approvals", "/production-fiche-approvals/summary", "/production-fiche-approvals/permissions"]) {
      expect([path, (await request(app).get(path).set(BO)).status]).toEqual([path, 403]);
    }
  });
});

describe("Production — autres comptes inchangés", () => {
  test("12. PROD1 : uniquement ses fiches ; commercial : aucun accès ; administrateur : toutes", async () => {
    const own = await fiches(PROD1.auth, "promesh");
    expect(sortIds(own.body.data)).toEqual(await sqlFicheIds("promesh", `AND "createdBy" = :u`, { u: PROD1.user.id }));
    const [other] = await sql(`SELECT id FROM por_promesh WHERE "createdBy" = :u LIMIT 1`, { u: PROD2.user.id });
    expect((await request(app).get(`/por-promesh/${other.id}`).set(PROD1.auth)).status).toBe(403);
    for (const path of ["/production-records/fiches?type=promesh", "/por-promesh", "/industrial-records", "/production-fiche-approvals/promesh/1"]) {
      expect([path, (await request(app).get(path).set(INFO.auth)).status]).toEqual([path, 403]);
    }
    expect(sortIds((await fiches(ADMIN.auth, "promesh")).body.data)).toEqual(await sqlFicheIds("promesh"));
  });
});

if (!PASSWORD) test.skip("BACKOFFICE_PASSWORD absent : tests du compte back-office non exécutés", () => {});
