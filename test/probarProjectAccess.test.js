"use strict";

// Harmonisation des droits "gestion des projets" des comptes
// @probardistribution.com sur le compte de référence
// info@probardistribution.com (config/probarProjectAccess.js). Même squelette
// que test/finance.access.test.js (mocks cron/mailer, DB réelle, fixtures
// uniques, nettoyage en afterAll). Aucun test ne déclenche l'automatisation
// Follow-up (calendrier/email) : seul le chemin de validation est exercé.

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
const Project = require("../src/models/Project");
const ProjectAction = require("../src/models/ProjectAction");
const UserProject = require("../src/models/UserProject");
const CommercialContact = require("../src/models/CommercialContact");
const CommercialContactRelance = require("../src/models/CommercialContactRelance");
const { signAccessToken } = require("../src/utils/tokens");
const {
  isProbarDomainEmail,
  isProbarProjectManager,
} = require("../src/config/probarProjectAccess");

const RUN_ID = Date.now();
const PASSWORD = "StrongPass123!";
const createdUserIds = [];
const createdProjectIds = [];
const createdContactIds = [];

async function createTestUser(email, role) {
  const user = await User.create({
    email,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    isActive: true,
    role,
  });
  createdUserIds.push(user.id);
  return user;
}

const tokenFor = (u) => signAccessToken({ sub: u.id, email: u.email, role: u.role });
const auth = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

async function createContact(createdBy) {
  const c = await CommercialContact.create({
    typeClient: "Batiment",
    nom: `Test${RUN_ID}`,
    prenom: "Probar",
    telephone: "20000000",
    statut: "ok",
    createdBy,
  });
  createdContactIds.push(c.id);
  return c;
}

describe("Règle de domaine @probardistribution.com (unitaire)", () => {
  test.each([
    ["info@probardistribution.com", true],
    ["aziz_nefzaoui@probardistribution.com", true],
    ["  Aziz_Nefzaoui@ProbarDistribution.COM  ", true],
    ["x@probardistribution.com.evil.tn", false],
    ["x@evilprobardistribution.com", false],
    ["x@evil-probardistribution.com", false],
    ["x@sub.probardistribution.com", false],
    ["probardistribution.com@gmail.com", false],
    ["a@b@probardistribution.com", false],
    ["@probardistribution.com", false],
    ["a b@probardistribution.com", false],
    ["", false],
    [null, false],
  ])("isProbarDomainEmail(%p) === %p", (email, expected) => {
    expect(isProbarDomainEmail(email)).toBe(expected);
  });

  test.each([
    ["user", true],
    ["commercial", true],
    ["admin", false],
    ["superadmin", false],
    ["superadmin2", false],
    ["accueil", false],
    ["finance_probar", false],
    ["finance_production", false],
    ["responsable_logistique_achat", false],
    ["controle_qualite", false],
  ])("rôle %s sur le domaine PROBAR → probarProjectManager=%p", (role, expected) => {
    expect(isProbarProjectManager({ role, email: "x@probardistribution.com" })).toBe(expected);
  });

  test("rôle commercial hors domaine → pas de droit PROBAR", () => {
    expect(isProbarProjectManager({ role: "commercial", email: "x@gmail.com" })).toBe(false);
  });
});

describe("Gestion des projets — comptes PROBAR vs autres comptes (API)", () => {
  let info; // compte de référence réel (lecture seule, aucun changement)
  let azizLike; // simule aziz_nefzaoui@ (rôle "user", comme un compte créé par l'admin)
  let probarCommercial; // autre compte autorisé du domaine (rôle "commercial")
  let otherDomain; // rôle "user" d'un autre domaine
  let lookalike; // domaine ressemblant
  let financeProbar; // Finance, même domaine
  let production; // Production, même domaine

  beforeAll(async () => {
    info = await User.findOne({ where: { email: "info@probardistribution.com" } });
    azizLike = await createTestUser(`aziz-test-${RUN_ID}@probardistribution.com`, "user");
    probarCommercial = await createTestUser(`commercial-test-${RUN_ID}@probardistribution.com`, "commercial");
    otherDomain = await createTestUser(`other-${RUN_ID}@example.com`, "user");
    lookalike = await createTestUser(`lookalike-${RUN_ID}@probardistribution.com.evil.tn`, "user");
    financeProbar = await createTestUser(`finance-${RUN_ID}@probardistribution.com`, "finance_probar");
    production = await createTestUser(`prod-${RUN_ID}@probardistribution.com`, "responsable_logistique_achat");
  }, 20000);

  afterAll(async () => {
    await CommercialContactRelance.destroy({ where: { commercialContactId: createdContactIds } });
    await CommercialContact.destroy({ where: { id: createdContactIds } });
    await ProjectAction.destroy({ where: { projectId: createdProjectIds } });
    await UserProject.destroy({ where: { projectId: createdProjectIds } });
    await Project.destroy({ where: { id: createdProjectIds } });
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  // ── 1. Session : drapeau calculé par le backend ──────────────────────────
  test.each([
    ["azizLike", true],
    ["probarCommercial", true],
    ["otherDomain", false],
    ["lookalike", false],
    ["financeProbar", false],
    ["production", false],
  ])("POST /auth/signin (%s) → permissions.probarProjectManager=%p", async (key, expected) => {
    const u = { azizLike, probarCommercial, otherDomain, lookalike, financeProbar, production }[key];
    const res = await request(app).post("/auth/signin").send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe(u.role); // rôle en base jamais modifié
    expect(res.body.user.permissions.probarProjectManager).toBe(expected);
  });

  test("info@probardistribution.com reste commercial et éligible (référence inchangée)", () => {
    expect(info).not.toBeNull();
    expect(info.role).toBe("commercial");
    expect(isProbarProjectManager(info)).toBe(true);
  });

  // ── 2. KPI Commercial Contacts — contrôle serveur (appel API direct) ────
  test.each(["/commercial-contacts/my-kpi", "/commercial-contacts/kpi", "/commercial-contacts/analytics"])(
    "%s : info@, aziz-like et commercial PROBAR → 200",
    async (path) => {
      for (const u of [info, azizLike, probarCommercial]) {
        const res = await request(app).get(path).set(auth(u));
        expect(res.status).toBe(200);
      }
    }
  );

  test.each(["/commercial-contacts/my-kpi", "/commercial-contacts/kpi"])(
    "%s : autre domaine, domaine ressemblant, Finance, Production → 403",
    async (path) => {
      for (const u of [otherDomain, lookalike, financeProbar, production]) {
        const res = await request(app).get(path).set(auth(u));
        expect(res.status).toBe(403);
      }
    }
  );

  test("JWT falsifié (rôle/email modifiés sans signature valide) → 401", async () => {
    const forged = tokenFor(otherDomain).replace(/\.[^.]+$/, ".invalidsignature");
    const res = await request(app).get("/commercial-contacts/my-kpi").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  // ── 3. Projets : consultation + création, identité du créateur conservée
  test.each(["azizLike", "probarCommercial"])("%s consulte et crée un projet (ownerId = lui-même)", async (key) => {
    const u = { azizLike, probarCommercial }[key];

    const list = await request(app).get("/projects/my-projects").set(auth(u));
    expect(list.status).toBe(200);

    const res = await request(app)
      .post("/projects")
      .set(auth(u))
      .send({
        projectModele: "revendeur",
        nomProjet: `Projet test ${RUN_ID}`,
        comptoir: `Comptoir test ${RUN_ID}`,
        firstAction: "Visite",
        dateVisite: "2026-10-21",
      });
    expect(res.status).toBe(201);
    const projectId = res.body.id || res.body.data?.id || res.body.project?.id;
    expect(projectId).toBeTruthy();
    createdProjectIds.push(projectId);

    const p = await Project.findByPk(projectId);
    expect(p.ownerId).toBe(u.id);
    const link = await UserProject.findOne({ where: { projectId, userId: u.id } });
    expect(link.permission).toBe("owner");
  });

  test("un compte PROBAR ne peut pas modifier le projet d'un autre (contrôle serveur inchangé)", async () => {
    const projectId = createdProjectIds[0];
    const res = await request(app).put(`/projects/${projectId}`).set(auth(probarCommercial)).send({ nomProjet: "x" });
    expect(res.status).toBe(403);
  });

  test("Finance / Production restent bloqués hors de leur module (moduleAccessGuard inchangé)", async () => {
    for (const u of [financeProbar, production]) {
      const res = await request(app).get("/projects/my-projects").set(auth(u));
      expect(res.status).toBe(403);
    }
  });

  // ── 4. Commercial Contacts : périmètre identique à info@ ────────────────
  test("aziz-like ne voit que ses contacts ; un 'user' d'un autre domaine garde la vue historique", async () => {
    const own = await createContact(azizLike.id);
    const foreign = await createContact(otherDomain.id);

    const resProbar = await request(app).get("/commercial-contacts").set(auth(azizLike));
    expect(resProbar.status).toBe(200);
    const probarIds = resProbar.body.map((c) => c.id);
    expect(probarIds).toContain(own.id);
    expect(probarIds).not.toContain(foreign.id);

    const resOther = await request(app).get("/commercial-contacts").set(auth(otherDomain));
    expect(resOther.status).toBe(200);
    const otherIds = resOther.body.map((c) => c.id);
    expect(otherIds).toEqual(expect.arrayContaining([own.id, foreign.id]));
  });

  // ── 5. Règle Follow-up d'info@ (commercial obligatoire) étendue ─────────
  test("relance datée sans commercial : refusée pour aziz-like comme pour info@", async () => {
    const contact = await createContact(azizLike.id);
    const res = await request(app)
      .post(`/commercial-contacts/${contact.id}/relances`)
      .set(auth(azizLike))
      .send({ dateRelance: "2026-11-01", heureRelance: "10:00" });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Commercial requis");
  });

  test("relance datée sans commercial : comportement inchangé hors domaine (pas d'obligation)", async () => {
    const contact = await createContact(otherDomain.id);
    const res = await request(app)
      .post(`/commercial-contacts/${contact.id}/relances`)
      .set(auth(otherDomain))
      .send({ dateRelance: "2026-11-01", heureRelance: "10:00" });
    expect(res.body.message).not.toBe("Commercial requis");
    expect(res.status).toBeLessThan(300);
  });
});
