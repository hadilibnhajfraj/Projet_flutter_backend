"use strict";

// Visibilité des contacts commerciaux (GET /commercial-contacts) — contre la
// base de DÉVELOPPEMENT locale, données existantes uniquement (rien n'est
// créé, modifié ni supprimé ; vérifié à la fin).
//
// Régressions couvertes :
//   - le back-office héritait du périmètre « commercial » de son compte de
//     référence (info@probardistribution.com) et ne voyait pas, par exemple,
//     les contacts d'Aziz ;
//   - le filtre « Filter by User » cherchait certains noms dans
//     user_nom_custom seul, alors que la ligne affiche user_nom en priorité
//     (« wajdi » renvoyait des contacts affichés comme ceux de najeh / mayssa).
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
const ids = (body) => body.map((c) => c.id).sort();

let BO;
let AZIZ;
let INFO;
let ADMIN;
let snapshot;
const quiet = jest.spyOn(console, "log").mockImplementation(() => {}); // logs très verbeux de la route

async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte absent : ${email}`);
  return { user: u, auth: tokenFor(u) };
}
// Périmètre « commercial » d'un compte, calculé en SQL indépendamment de la route.
const commercialScopeIds = async (userId) =>
  (
    await sql(
      `SELECT id FROM commercial_contacts WHERE "createdBy" = :u OR "commercialId" = :u
          OR id IN (SELECT "commercialContactId" FROM commercial_contact_relances WHERE "commercialId" = :u)`,
      { u: userId }
    )
  )
    .map((r) => r.id)
    .sort();

beforeAll(async () => {
  [AZIZ, INFO, ADMIN] = await Promise.all([
    account("aziz_nefzaoui@probardistribution.com"),
    account("info@probardistribution.com"),
    account("cbitunisia@cbi-tunisia.com"),
  ]);
  _resetCache();
  if (PASSWORD) {
    const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
    expect(res.status).toBe(200);
    BO = { Authorization: `Bearer ${res.body.accessToken}` };
  }
  snapshot = await sql(`SELECT COUNT(*)::int n, MAX("updatedAt") m FROM commercial_contacts`);
});

afterAll(async () => {
  // Aucun contact créé, modifié ni supprimé.
  expect(await sql(`SELECT COUNT(*)::int n, MAX("updatedAt") m FROM commercial_contacts`)).toEqual(snapshot);
  quiet.mockRestore();
  await sequelize.close();
});

describe("Contacts commerciaux — comptes CRM", () => {
  test("1. Aziz voit ses contacts (périmètre commercial inchangé)", async () => {
    const res = await request(app).get("/commercial-contacts").set(AZIZ.auth);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(await commercialScopeIds(AZIZ.user.id));
    const [{ n }] = await sql(`SELECT COUNT(*)::int n FROM commercial_contacts WHERE "createdBy" = :a`, { a: AZIZ.user.id });
    expect(res.body.filter((c) => c.createdByEmail === AZIZ.user.email)).toHaveLength(n);
    expect(n).toBeGreaterThan(0);
  });

  test("le compte de référence info@ garde son périmètre (aucun élargissement)", async () => {
    const res = await request(app).get("/commercial-contacts").set(INFO.auth);
    expect(ids(res.body)).toEqual(await commercialScopeIds(INFO.user.id));
  });

  test("un commercial : créateurs et filtre createdBy restent dans son périmètre", async () => {
    const scope = new Set(await commercialScopeIds(AZIZ.user.id));
    const creators = (await request(app).get("/commercial-contacts/creators/list").set(AZIZ.auth)).body;
    expect(creators.reduce((s, c) => s + c.count, 0)).toBe(scope.size);
    const res = await request(app).get(`/commercial-contacts?createdBy=${INFO.user.id}`).set(AZIZ.auth);
    expect(res.body.every((c) => scope.has(c.id))).toBe(true);
  });

  test("5. administrateur : visibilité globale, vrai créateur sur chaque ligne", async () => {
    const res = await request(app).get("/commercial-contacts").set(ADMIN.auth);
    const all = (await sql(`SELECT id FROM commercial_contacts`)).map((r) => r.id).sort();
    expect(ids(res.body)).toEqual(all);
    const creators = Object.fromEntries((await sql(`SELECT c.id, u.email FROM commercial_contacts c LEFT JOIN users u ON u.id = c."createdBy"`)).map((r) => [r.id, r.email]));
    for (const c of res.body) expect([c.id, c.createdByEmail]).toEqual([c.id, creators[c.id]]);
  });
});

describeIfPassword("Contacts commerciaux — back-office", () => {
  test("2-4, 8. vue globale : tous les contacts, dont ceux d'Aziz, des comptes @probardistribution.com et des administrateurs", async () => {
    const res = await request(app).get("/commercial-contacts").set(BO);
    expect(res.status).toBe(200);
    const all = (await sql(`SELECT id FROM commercial_contacts`)).map((r) => r.id).sort();
    expect(ids(res.body)).toEqual(all); // total affiché = total réel en base
    const seen = new Set(res.body.map((c) => c.id));
    for (const [label, query] of [
      ["Aziz", `SELECT c.id FROM commercial_contacts c JOIN users u ON u.id = c."createdBy" WHERE u.email = 'aziz_nefzaoui@probardistribution.com'`],
      ["@probardistribution.com", `SELECT c.id FROM commercial_contacts c JOIN users u ON u.id = c."createdBy" WHERE u.email LIKE '%@probardistribution.com'`],
      ["administrateurs", `SELECT c.id FROM commercial_contacts c JOIN users u ON u.id = c."createdBy" WHERE u.role IN ('admin','superadmin','superadmin2')`],
    ]) {
      const expected = (await sql(query)).map((r) => r.id);
      expect([label, expected.filter((id) => !seen.has(id))]).toEqual([label, []]);
    }
    // Même liste qu'un administrateur.
    const adm = await request(app).get("/commercial-contacts").set(ADMIN.auth);
    expect(ids(res.body)).toEqual(ids(adm.body));
    // Détail et historique d'un contact d'Aziz.
    const azizContact = res.body.find((c) => c.createdByEmail === AZIZ.user.email);
    expect((await request(app).get(`/commercial-contacts/${azizContact.id}`).set(BO)).status).toBe(200);
    expect((await request(app).get(`/commercial-contacts/${azizContact.id}/actions`).set(BO)).status).toBe(200);
  });

  test("6. filtre par utilisateur : même nom que la ligne affichée, sur tous les contacts visibles", async () => {
    const names = (await request(app).get("/commercial-contacts/user-names/list").set(BO)).body;
    expect(names).toEqual(expect.arrayContaining(["aziz"]));
    let sum = 0;
    for (const name of names) {
      const res = await request(app).get(`/commercial-contacts?user_nom=${encodeURIComponent(name)}`).set(BO);
      const [{ n }] = await sql(`SELECT COUNT(*)::int n FROM commercial_contacts WHERE lower(COALESCE(user_nom::text, user_nom_custom)) = :name`, { name: name.toLowerCase() });
      expect([name, res.body.length]).toEqual([name, n]);
      expect(res.body.every((c) => c.user_nom.toLowerCase() === name.toLowerCase())).toBe(true); // nom affiché
      sum += n;
    }
    const [{ named }] = await sql(`SELECT COUNT(*)::int named FROM commercial_contacts WHERE COALESCE(user_nom::text, user_nom_custom) IS NOT NULL`);
    expect(sum).toBe(named);
    // « aziz » : exactement les contacts créés par Aziz.
    const aziz = await request(app).get(`/commercial-contacts?user_nom=aziz`).set(BO);
    expect(aziz.body.every((c) => c.createdByEmail === AZIZ.user.email)).toBe(true);
    // Recherche et type combinés au filtre : toujours dans le périmètre global.
    const [sample] = await sql(`SELECT "nomSociete", "typeClient"::text t FROM commercial_contacts WHERE "nomSociete" IS NOT NULL AND "typeClient" IS NOT NULL LIMIT 1`);
    if (sample) {
      const r = await request(app).get(`/commercial-contacts?q=${encodeURIComponent(sample.nomSociete)}&typeClient=${encodeURIComponent(sample.t)}`).set(BO);
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.body.every((c) => c.typeClient === sample.t)).toBe(true);
    }
  });

  test("7. vrai créateur sur chaque ligne (relation createdBy), et nombre de contacts par créateur", async () => {
    const res = await request(app).get("/commercial-contacts").set(BO);
    const rows = await sql(`SELECT c.id, u.email FROM commercial_contacts c LEFT JOIN users u ON u.id = c."createdBy"`);
    const creators = Object.fromEntries(rows.map((r) => [r.id, r.email]));
    for (const c of res.body) {
      expect([c.id, c.createdByEmail]).toEqual([c.id, creators[c.id]]);
      expect(c.createdByName).toBeTruthy();
    }
    const perCreator = {};
    for (const c of res.body) perCreator[c.createdByEmail] = (perCreator[c.createdByEmail] || 0) + 1;
    const dbPer = await sql(`SELECT u.email, COUNT(*)::int n FROM commercial_contacts c JOIN users u ON u.id = c."createdBy" GROUP BY u.email`);
    expect(perCreator).toEqual(Object.fromEntries(dbPer.map((r) => [r.email, r.n])));
  });

  test("filtre par créateur réel (?createdBy=<users.id>) : chaque créateur = requête SQL, sans perte ni doublon", async () => {
    const creators = (await request(app).get("/commercial-contacts/creators/list").set(BO)).body;
    const dbPer = await sql(
      `SELECT c."createdBy" id, u.email, COUNT(*)::int n FROM commercial_contacts c LEFT JOIN users u ON u.id = c."createdBy" GROUP BY c."createdBy", u.email`
    );
    expect(creators.map((c) => [c.id, c.email, c.count]).sort()).toEqual(dbPer.map((r) => [r.id, r.email, r.n]).sort());
    expect(creators.find((c) => c.email === AZIZ.user.email).name).toBe("Aziz Nefzaoui"); // sans profil : dérivé de l'email
    const seen = [];
    for (const c of creators) {
      const res = await request(app).get(`/commercial-contacts?createdBy=${c.id}`).set(BO);
      expect(res.status).toBe(200);
      const expected = (await sql(`SELECT id FROM commercial_contacts WHERE "createdBy" = :id`, { id: c.id })).map((r) => r.id).sort();
      expect([c.email, ids(res.body)]).toEqual([c.email, expected]);
      expect(res.body.every((x) => x.createdByEmail === c.email)).toBe(true); // jamais de mélange
      seen.push(...res.body.map((x) => x.id));
    }
    const all = (await sql(`SELECT id FROM commercial_contacts`)).map((r) => r.id).sort();
    expect(seen.sort()).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
    expect((await request(app).get(`/commercial-contacts?createdBy=aziz`).set(BO)).status).toBe(400);
  });

  test("9. le back-office ne peut toujours ni créer, ni modifier, ni supprimer, ni affecter", async () => {
    const [c] = await sql(`SELECT id FROM commercial_contacts LIMIT 1`);
    for (const r of [
      request(app).post("/commercial-contacts").set(BO).send({ nom: "x" }),
      request(app).put(`/commercial-contacts/${c.id}`).set(BO).send({ nom: "x" }),
      request(app).delete(`/commercial-contacts/${c.id}`).set(BO),
      request(app).post("/commercial-contacts/assign").set(BO).send({ contactIds: [c.id], commercialId: AZIZ.user.id }),
      request(app).post(`/commercial-contacts/${c.id}/actions`).set(BO).send({}),
      request(app).post(`/commercial-contacts/${c.id}/relances`).set(BO).send({}),
      request(app).post("/commercial-contacts/user-names").set(BO).send({ name: "x" }),
    ]) {
      const res = await r;
      expect([res.status, res.body.code]).toEqual([403, "READ_ONLY_ACCOUNT"]);
    }
  });
});

if (!PASSWORD) test.skip("BACKOFFICE_PASSWORD absent : tests du compte back-office non exécutés", () => {});
