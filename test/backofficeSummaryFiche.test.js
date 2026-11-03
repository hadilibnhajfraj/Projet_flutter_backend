"use strict";

// Récapitulatifs PROBAR / PROMESH → fiche ORIGINALE, compte back-office en
// consultation seule. Chaque ligne du récapitulatif porte l'id réel de la
// fiche (« promesh:<uuid> » / « probar:<uuid> ») ; l'écran ouvre le détail
// existant (GET /por-promesh/:id, GET /industrial-records/:id) avec cet id.
// Base de DÉVELOPPEMENT locale, données existantes uniquement : rien n'est
// créé, modifié ni supprimé (vérifié à la fin).
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (v) => (v == null ? null : String(v).slice(0, 10));

const DETAIL = { promesh: (id) => `/por-promesh/${id}`, probar: (id) => `/industrial-records/${id}` };
// Colonnes réelles de la fiche (tables por_promesh / industrial_records).
const SOURCE = {
  promesh: (id) => sql(`SELECT id, machine::text machine, poste::text poste, "dateProduction"::text date, "createdBy" FROM por_promesh WHERE id = :id`, { id }),
  probar: (id) => sql(`SELECT id, machine::text machine, poste::text poste, "dateFiche"::text date, "createdBy" FROM industrial_records WHERE module = 'probar' AND id = :id`, { id }),
};

let BO;
let ADMIN;
let PROD1;
let INFO;
let snapshot;
const summaryRows = {};

async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte absent : ${email}`);
  return { user: u, auth: tokenFor(u) };
}

async function fingerprint() {
  return sql(`SELECT
      (SELECT COUNT(*)::int FROM por_promesh) promesh, (SELECT MAX("updatedAt") FROM por_promesh) promesh_m,
      (SELECT COUNT(*)::int FROM por_promesh WHERE status::text = 'ARCHIVED') promesh_archived,
      (SELECT COUNT(*)::int FROM industrial_records WHERE statut::text = 'archivee') probar_archived,
      (SELECT COUNT(*)::int FROM industrial_records) probar, (SELECT MAX("updatedAt") FROM industrial_records) probar_m,
      (SELECT COUNT(*)::int FROM por_promesh_attachments) attachments`);
}

// Ouvre la fiche d'une ligne du récapitulatif comme le fait l'écran
// (ProdPaths.ficheDetail : id composite → uuid) et la compare à la base.
async function openFromSummary(type, row) {
  const [prefix, id] = String(row.id).split(":");
  expect([prefix, UUID.test(id)]).toEqual([type, true]);
  const res = await request(app).get(DETAIL[type](id)).set(BO);
  expect([type, id, res.status]).toEqual([type, id, 200]);
  const fiche = res.body.data ?? res.body;
  const [src] = await SOURCE[type](id);
  expect(src).toBeDefined(); // la ligne pointe vers une fiche réelle
  // Le détail EST la fiche d'origine : mêmes valeurs que la table…
  expect({ id: String(fiche.id), machine: String(fiche.machine), poste: fiche.poste, createdBy: fiche.createdBy })
    .toEqual({ id: String(src.id), machine: String(src.machine), poste: src.poste, createdBy: src.createdBy });
  // …et que la ligne du récapitulatif (date, machine, équipe).
  expect({ date: day(row.date), machine: String(row.machine), poste: row.poste }).toEqual({ date: day(src.date), machine: String(src.machine), poste: src.poste });
  // Même contenu complet que pour l'administrateur (aucun champ masqué).
  expect(res.body).toEqual((await request(app).get(DETAIL[type](id)).set(ADMIN.auth)).body);
  return { id, fiche };
}

beforeAll(async () => {
  [ADMIN, PROD1, INFO] = await Promise.all([
    account("cbitunisia@cbi-tunisia.com"),
    account("production_1@cbi-tunisia.com"),
    account("info@probardistribution.com"),
  ]);
  _resetCache();
  if (PASSWORD) {
    const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
    expect(res.status).toBe(200);
    BO = { Authorization: `Bearer ${res.body.accessToken}` };
    for (const type of ["promesh", "probar"]) {
      const s = await request(app).get(`/production-records/summary?type=${type}&period=all`).set(BO);
      expect([type, s.status]).toEqual([type, 200]);
      summaryRows[type] = s.body.data?.[type]?.rows ?? [];
    }
  }
  snapshot = await fingerprint();
});

afterAll(async () => {
  expect(await fingerprint()).toEqual(snapshot); // aucune fiche modifiée
  await sequelize.close();
});

describeIfPassword("Récapitulatif → fiche originale (back-office)", () => {
  test.each(["1", "2", "3", "4"])("1-4. PROMESH %s : chaque ligne du récapitulatif ouvre sa fiche réelle", async (machine) => {
    const rows = summaryRows.promesh.filter((r) => String(r.machine) === machine);
    // Lignes du récapitulatif = fiches réelles non archivées de la machine
    // (règle existante du récapitulatif, tous rôles).
    const listed = await sql(`SELECT id FROM por_promesh WHERE machine::text = :machine AND status::text <> 'ARCHIVED'`, { machine });
    expect(rows.map((r) => String(r.id).split(":")[1]).sort()).toEqual(listed.map((x) => String(x.id)).sort());
    for (const row of rows) {
      const { fiche } = await openFromSummary("promesh", row);
      // Paramètres de production et contrôle qualité enregistrés sur la fiche.
      expect(Array.isArray(fiche.controlesQualite)).toBe(true);
      expect(Array.isArray(fiche.attachments)).toBe(true);
    }
    if (rows.length === 0) {
      // Aucune fiche active sur cette machine en base locale : la fiche réelle
      // (archivée) reste consultable par son id, à l'identique de l'administrateur.
      const [real] = await sql(`SELECT id, status::text status, "updatedAt" FROM por_promesh WHERE machine::text = :machine ORDER BY id LIMIT 1`, { machine });
      expect(real).toBeDefined();
      const res = await request(app).get(`/por-promesh/${real.id}`).set(BO);
      expect(res.status).toBe(200);
      expect(String(res.body.data.machine)).toBe(machine);
      expect(res.body).toEqual((await request(app).get(`/por-promesh/${real.id}`).set(ADMIN.auth)).body);
      // La lecture ne modifie jamais la fiche (une fiche archivée reste archivée).
      const [after] = await sql(`SELECT id, status::text status, "updatedAt" FROM por_promesh WHERE id = :id`, { id: real.id });
      expect(after).toEqual(real);
    }
  });

  test("5. PROBAR : chaque ligne du récapitulatif ouvre sa fiche réelle", async () => {
    expect(summaryRows.probar.length).toBeGreaterThan(0);
    for (const row of summaryRows.probar) await openFromSummary("probar", row);
  });

  test("6. les lignes couvrent PROD1 et PROD2, Matin et Nuit — sans filtre propriétaire", async () => {
    const promeshIds = new Set(summaryRows.promesh.map((r) => String(r.id).split(":")[1]));
    const creators = await sql(`SELECT DISTINCT u.email FROM por_promesh p JOIN users u ON u.id = p."createdBy" WHERE p.id IN (:ids)`, { ids: [...promeshIds] });
    const emails = creators.map((c) => c.email);
    expect(emails).toEqual(expect.arrayContaining(["production_1@cbi-tunisia.com", "production_2@cbi-tunisia.com"]));
    expect(new Set(summaryRows.promesh.map((r) => r.poste))).toEqual(new Set(["matin", "nuit"]));
    // Mêmes lignes (mêmes ids) que le récapitulatif de l'administrateur.
    for (const type of ["promesh", "probar"]) {
      const adm = await request(app).get(`/production-records/summary?type=${type}&period=all`).set(ADMIN.auth);
      expect(summaryRows[type].map((r) => r.id).sort()).toEqual((adm.body.data?.[type]?.rows ?? []).map((r) => r.id).sort());
    }
  });

  test("7. contrôle qualité, documents et historique de validation de la fiche ouverte", async () => {
    const withQc = summaryRows.promesh.find((r) => r.machine != null);
    const { id, fiche } = await openFromSummary("promesh", withQc);
    const [{ n }] = await sql(`SELECT COUNT(*)::int n FROM por_promesh_attachments WHERE "porPromeshId" = :id`, { id });
    expect(fiche.attachments.length).toBe(n); // documents réels de la fiche
    const pdf = await request(app).get(`/por-promesh/${id}/pdf`).set(BO).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toMatch(/application\/pdf/);
    // Historique de validation : lignes dont la fiche a été soumise à validation.
    const submitted = {
      promesh: await sql(`SELECT id FROM por_promesh WHERE "approvalStatus" IS NOT NULL`),
      probar: await sql(`SELECT id FROM industrial_records WHERE module = 'probar' AND "approvalStatus" IS NOT NULL`),
    };
    for (const type of ["promesh", "probar"]) {
      const ids = new Set(submitted[type].map((x) => String(x.id)));
      const row = summaryRows[type].find((r) => ids.has(String(r.id).split(":")[1]));
      // Ligne du récapitulatif si une fiche soumise y figure ; sinon la fiche
      // soumise réelle (ex. PROBAR en base locale : seule fiche soumise hors récapitulatif).
      const fid = row ? String(row.id).split(":")[1] : [...ids][0];
      expect([type, fid != null]).toEqual([type, true]);
      const h = await request(app).get(`/production-fiche-approvals/${type}/${fid}`).set(BO);
      expect([type, h.status]).toEqual([type, 200]);
      expect(Array.isArray(h.body.data.history)).toBe(true);
      expect([h.body.data.canDecide, h.body.data.canResubmit]).toEqual([false, false]);
    }
  });

  test("8. appels directs à l'API : aucune écriture sur la fiche ouverte", async () => {
    const p = String(summaryRows.promesh[0].id).split(":")[1];
    const b = String(summaryRows.probar[0].id).split(":")[1];
    const writes = [
      ["put", `/por-promesh/${p}`, { observationsGenerales: "x" }],
      ["delete", `/por-promesh/${p}`],
      ["post", `/por-promesh/${p}/validate`, {}],
      ["post", `/por-promesh/${p}/attachments`, {}],
      ["put", `/industrial-records/${b}`, { observations: "x" }],
      ["delete", `/industrial-records/${b}`],
      ["post", `/production-fiche-approvals/promesh/${p}/approve`, {}],
      ["post", `/production-fiche-approvals/probar/${b}/reject`, { comment: "refus de test" }],
      ["post", "/production-draft-archive/requests", {}],
      ["post", "/quality-control", {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await request(app)[method](path).set(BO).send(body);
      expect([method, path, res.status, res.body.code]).toEqual([method, path, 403, "READ_ONLY_ACCOUNT"]);
    }
  });
});

describe("Autres comptes inchangés", () => {
  test("9. PROD1 : ses fiches seulement ; commercial : aucun accès ; administrateur : toutes", async () => {
    const [own] = await sql(`SELECT id FROM por_promesh WHERE "createdBy" = :u LIMIT 1`, { u: PROD1.user.id });
    expect((await request(app).get(`/por-promesh/${own.id}`).set(PROD1.auth)).status).toBe(200);
    const [other] = await sql(`SELECT id FROM por_promesh WHERE "createdBy" <> :u LIMIT 1`, { u: PROD1.user.id });
    expect((await request(app).get(`/por-promesh/${other.id}`).set(PROD1.auth)).status).toBe(403);
    for (const path of ["/production-records/summary?type=promesh", `/por-promesh/${own.id}`, "/industrial-records"]) {
      expect([path, (await request(app).get(path).set(INFO.auth)).status]).toEqual([path, 403]);
    }
    expect((await request(app).get(`/por-promesh/${other.id}`).set(ADMIN.auth)).status).toBe(200);
  });
});

if (!PASSWORD) test.skip("BACKOFFICE_PASSWORD absent : tests du compte back-office non exécutés", () => {});
