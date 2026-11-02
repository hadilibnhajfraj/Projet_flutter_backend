"use strict";

// Compte back-office en CONSULTATION SEULE (backoffice@cbi-tunisia.com, rôle
// backoffice_readonly) — contre la base de développement, AUCUNE donnée
// modifiée (chaque écriture tentée doit être refusée avant le routeur ; des
// comptages vérifient que rien n'a bougé).
//
// Connexion RÉELLE par POST /auth/signin : mot de passe lu dans la variable
// d'environnement BACKOFFICE_PASSWORD (jamais écrit dans le code, jamais
// affiché) — suite ignorée si elle est absente.

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
const { signAccessToken, verifyAccessToken } = require("../src/utils/tokens");
const cfg = require("../src/config/backofficeReadOnly");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");

const PASSWORD = process.env.BACKOFFICE_PASSWORD;
const describeIfPassword = PASSWORD ? describe : describe.skip;
const EMAIL = "backoffice@cbi-tunisia.com";
const REFERENCE = "info@probardistribution.com";

const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
async function signed(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  return { user: u, token: signAccessToken({ sub: u.id, email: u.email, role: u.role }) };
}

// Lectures du compte de référence (commercial) — mêmes écrans que Flutter.
const READS = [
  "/commercial-contacts",
  "/commercial-contacts?page=1&limit=10",
  "/commercial-contacts/user-names/list",
  "/commercial-contacts/calendar/relances",
  "/commercial-contacts/kpi/me",
  "/commercial-contacts/my-kpi",
  "/commercial-contacts/analytics",
  "/crm/upcoming-followups",
  "/projects",
  "/projects/my-projects",
  "/projects/calendar",
  "/projects/user-kpi",
  "/tasks",
  "/tasks/my-projects",
  "/api/clients/all",
];

// Volume total des tables métier : identique avant / après les tentatives
// (seule la session du compte back-office lui-même est mise à jour par sa
// connexion — écriture autorisée sur son propre compte).
const SNAPSHOT_SQL = `SELECT
  (SELECT count(*) FROM projects) p, (SELECT max("updatedAt") FROM projects) pu,
  (SELECT count(*) FROM commercial_contacts) c, (SELECT max("updatedAt") FROM commercial_contacts) cu,
  (SELECT count(*) FROM clients) cl, (SELECT count(*) FROM users) u,
  (SELECT max("updatedAt") FROM users WHERE email <> 'backoffice@cbi-tunisia.com') uu,
  (SELECT count(*) FROM por_promesh) pm, (SELECT count(*) FROM raw_material_requests) rm`;

let token; // jeton obtenu par la vraie connexion
let ref;
let snapshot;

afterAll(() => sequelize.close());

describeIfPassword("Compte back-office en consultation seule", () => {
  beforeAll(async () => {
    ref = await signed(REFERENCE);
    [snapshot] = await sql(SNAPSHOT_SQL);
  });

  afterAll(async () => {
    const [after] = await sql(SNAPSHOT_SQL);
    expect(JSON.stringify(after)).toBe(JSON.stringify(snapshot)); // aucune donnée modifiée
  });

  test("1. connexion réelle : rôle dédié, actif, consultation seule, jamais administrateur", async () => {
    const res = await request(app).post("/auth/signin").send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    token = res.body.accessToken;
    const payload = verifyAccessToken(token);
    expect(payload).toMatchObject({ email: EMAIL, role: "backoffice_readonly" });
    expect(res.body.user).toMatchObject({ email: EMAIL, role: "backoffice_readonly", isActive: true });
    expect(res.body.user.permissions).toEqual({ probarProjectManager: false, readOnly: true, referenceEmail: REFERENCE });
    expect(["admin", "superadmin", "superadmin2"]).not.toContain(payload.role);
    const [row] = await sql(`SELECT "passwordHash" h FROM users WHERE email = :e`, { e: EMAIL });
    expect(row.h).toMatch(/^\$2[aby]\$12\$/); // bcrypt, jamais le mot de passe en clair
    expect(row.h).not.toContain(PASSWORD);
    expect((await request(app).post("/auth/signin").send({ email: EMAIL, password: `${PASSWORD}x` })).status).toBe(401);
  });

  test("2-3. visibilité = celle d'info@probardistribution.com : mêmes statuts, mêmes données", async () => {
    for (const path of READS) {
      const mine = await request(app).get(path).set(bearer(token));
      const theirs = await request(app).get(path).set(bearer(ref.token));
      expect([path, mine.status]).toEqual([path, theirs.status]);
      expect([path, mine.status < 500]).toEqual([path, true]);
      expect([path, JSON.stringify(mine.body)]).toEqual([path, JSON.stringify(theirs.body)]);
    }
    // Détail d'un contact visible par info@ (s'il en a) — ce que le formulaire
    // en consultation affiche (champs, produits, projets, relances, historique
    // des statuts) : réponse identique, octet pour octet.
    const list = await request(app).get("/commercial-contacts?limit=1").set(bearer(ref.token));
    const id = (list.body.data || list.body.items || list.body)?.[0]?.id;
    if (id) {
      for (const path of [`/commercial-contacts/${id}`, `/commercial-contacts/${id}/actions`]) {
        const mine = await request(app).get(path).set(bearer(token));
        const theirs = await request(app).get(path).set(bearer(ref.token));
        expect([path, mine.status]).toEqual([path, theirs.status]);
        expect([path, JSON.stringify(mine.body)]).toEqual([path, JSON.stringify(theirs.body)]);
      }
      const detail = (await request(app).get(`/commercial-contacts/${id}`).set(bearer(token))).body;
      const contact = detail.data || detail;
      for (const field of ["nom", "telephone", "statut"]) expect(contact).toHaveProperty(field);
    }
  });

  test("jamais plus que la référence : routes administrateur et autres modules refusés comme pour info@", async () => {
    for (const path of ["/admin/users", "/crm/kpi/global", "/users", "/por-promesh", "/production-records/fiches?type=promesh", "/finance/invoices", "/quality-control"]) {
      const mine = await request(app).get(path).set(bearer(token));
      const theirs = await request(app).get(path).set(bearer(ref.token));
      expect([path, mine.status]).toEqual([path, theirs.status]);
      expect([path, mine.status >= 400]).toEqual([path, true]);
    }
  });

  test("identité propre : /users/me renvoie le compte back-office, jamais info@", async () => {
    const res = await request(app).get("/users/me/profile").set(bearer(token));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(EMAIL);
    expect(JSON.stringify(res.body)).not.toContain(REFERENCE);
  });

  test("4. créations, modifications, suppressions, validations, archivages, imports → 403", async () => {
    const [p] = await sql(`SELECT id FROM projects LIMIT 1`);
    const [c] = await sql(`SELECT id FROM commercial_contacts LIMIT 1`);
    const [f] = await sql(`SELECT id FROM por_promesh LIMIT 1`);
    const [rm] = await sql(`SELECT id FROM raw_material_requests LIMIT 1`);
    const [u] = await sql(`SELECT id FROM users WHERE email = :e`, { e: REFERENCE });
    const ATTEMPTS = [
      ["post", "/projects", { name: "x" }],
      ["put", `/projects/${p?.id}`, { name: "x" }],
      ["delete", `/projects/${p?.id}`],
      ["patch", `/projects/${p?.id}/status`, { status: "x" }],
      ["post", `/projects/${p?.id}/comments`, { text: "x" }],
      ["post", "/commercial-contacts", { name: "x" }],
      ["put", `/commercial-contacts/${c?.id}`, { name: "x" }],
      ["delete", `/commercial-contacts/${c?.id}`],
      ["post", `/commercial-contacts/${c?.id}/actions`, {}],
      ["post", "/commercial-contacts/import-csv", {}],
      ["post", "/api/clients", { name: "x" }],
      ["post", "/por-promesh/new", { machine: "1", poste: "matin" }],
      ["post", `/production-fiche-approvals/promesh/${f?.id}/approve`, {}],
      ["post", `/production-fiche-approvals/promesh/${f?.id}/reject`, { comment: "x" }],
      ["patch", `/raw-material-requests/${rm?.id}/status`, { status: "VALIDATED" }],
      ["post", "/archive-requests", { projectId: p?.id }],
      ["post", "/production-draft-archive/requests", {}],
      ["post", "/notifications/send-email", { to: "x@y.z" }],
      ["put", `/users/${u.id}`, { role: "admin" }],
      ["patch", `/users/${u.id}`, { isActive: false }],
      ["post", "/admin/users", {}],
      ["put", "/users/me/profile", { phone: "x" }],
      ["post", "/auth/signup", { email: "x@y.z", password: "Xx1!xxxxxx" }],
      ["post", "/uploads", {}],
      // Écrans consultés en lecture (contact, agenda, relances, tâches).
      ["put", `/commercial-contacts/${c?.id}/relances/x`, { statutRelance: "faite" }],
      ["put", `/commercial-contacts/${c?.id}/relances/x`, { dateRelance: "2026-12-01" }],
      ["post", `/commercial-contacts/${c?.id}/relances`, { dateRelance: "2026-12-01" }],
      ["patch", `/commercial-contacts/${c?.id}`, { userNom: "x" }],
      ["post", "/tasks", { title: "x", start: "2026-12-01T08:00:00Z" }],
      ["put", "/tasks/x", { title: "x" }],
      ["delete", "/tasks/x"],
      ["delete", `/commercial-contacts/${c?.id}/actions/x`],
    ];
    for (const [method, path, body] of ATTEMPTS) {
      const res = await request(app)[method](path).set(bearer(token)).send(body || {});
      expect([method, path, res.status, res.body.code]).toEqual([method, path, 403, "READ_ONLY_ACCOUNT"]);
    }
  });

  test("5. contournements directs de l'API : casse, barres obliques, en-têtes, jeton forgé", async () => {
    const tries = [
      () => request(app).post("/PROJECTS").set(bearer(token)).send({}),
      () => request(app).post("//projects/").set(bearer(token)).send({}),
      () => request(app).post("/projects").set(bearer(token)).set("X-HTTP-Method-Override", "GET").send({}),
      () => request(app).delete("/Commercial-Contacts/x").set(bearer(token)),
      () => request(app).get("/Google-Calendar/auth-url").set(bearer(token)),
      () => request(app).get("//google-calendar//auth-url/").set(bearer(token)),
      () => request(app).post("/AUTH/signin/../signup").set(bearer(token)).send({}),
    ];
    for (const t of tries) {
      const res = await t();
      expect(res.status).toBe(403);
    }
    // Un jeton se réclamant d'un autre rôle n'est accepté que signé : forgé → 401.
    const forged = `${token.split(".")[0]}.${Buffer.from(JSON.stringify({ sub: "x", email: EMAIL, role: "superadmin" })).toString("base64url")}.${token.split(".")[2]}`;
    expect((await request(app).get("/admin/users").set(bearer(forged))).status).toBe(401);
  });

  test("compte de référence absent ou administrateur → consultation refusée (jamais élargie)", async () => {
    const saved = process.env.BACKOFFICE_REFERENCE_EMAIL;
    try {
      for (const email of ["inexistant@cbi-tunisia.com", "cbitunisia@cbi-tunisia.com"]) {
        process.env.BACKOFFICE_REFERENCE_EMAIL = email;
        _resetCache();
        const res = await request(app).get("/projects").set(bearer(token));
        expect([email, res.status, res.body.code]).toEqual([email, 403, "REFERENCE_UNAVAILABLE"]);
      }
    } finally {
      if (saved === undefined) delete process.env.BACKOFFICE_REFERENCE_EMAIL;
      else process.env.BACKOFFICE_REFERENCE_EMAIL = saved;
      _resetCache();
    }
  });

  test("6. aucune régression : les autres comptes ne passent jamais par ce garde", async () => {
    for (const email of [REFERENCE, "responsable_production@cbi-tunisia.com", "production_1@cbi-tunisia.com", "cbitunisia@cbi-tunisia.com"]) {
      const { token: t } = await signed(email);
      // Écriture invalide : la route répond elle-même (validation, 400/404/422),
      // jamais le refus « consultation seule ».
      const res = await request(app).post("/projects").set(bearer(t)).send({});
      expect([email, res.body?.code]).not.toEqual([email, "READ_ONLY_ACCOUNT"]);
    }
    expect(cfg.isReadOnlyRole("commercial")).toBe(false);
  });
});

if (!PASSWORD) test.skip("BACKOFFICE_PASSWORD absent : tests du compte back-office non exécutés", () => {});
