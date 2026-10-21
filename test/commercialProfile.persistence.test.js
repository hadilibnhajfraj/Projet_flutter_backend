"use strict";

// Persistance des profils commerciaux personnalisés ("Autre commercial" de la
// dialog "Sélection du commercial") — table commercial_profiles,
// POST /commercial-contacts/user-names, GET /commercial-contacts/user-names/list.
// Même squelette que test/finance.access.test.js (mocks cron/mailer, DB
// réelle, fixtures uniques, nettoyage en afterAll).

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
const CommercialProfile = require("../src/models/CommercialProfile");
const { signAccessToken } = require("../src/utils/tokens");

const RUN_ID = Date.now();
const PASSWORD = "StrongPass123!";
const createdUserIds = [];

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

async function signIn(user) {
  const res = await request(app).post("/auth/signin").send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

const tokenAuth = (u) => ({
  Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}`,
});

const listNames = async (headers) => {
  const res = await request(app).get("/commercial-contacts/user-names/list").set(headers);
  expect(res.status).toBe(200);
  return res.body;
};

describe("Profils commerciaux personnalisés — persistance", () => {
  let aziz; // simule aziz_nefzaoui@probardistribution.com
  let otherCommercial;
  let otherDomain;

  beforeAll(async () => {
    aziz = await createTestUser(`aziz-profile-${RUN_ID}@probardistribution.com`, "user");
    otherCommercial = await createTestUser(`commercial-profile-${RUN_ID}@probardistribution.com`, "commercial");
    otherDomain = await createTestUser(`other-profile-${RUN_ID}@example.com`, "user");
  }, 20000);

  afterAll(async () => {
    await CommercialProfile.destroy({ where: { userId: createdUserIds } });
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  test("scénario complet : création, déconnexion, reconnexion, sélection, actualisation", async () => {
    // 1. Connexion
    let headers = await signIn(aziz);
    expect(await listNames(headers)).toEqual(expect.arrayContaining(["najeh", "mooemen", "mayssa", "wajdi"]));

    // 2-3. "Autre commercial" = aziz → Confirmer
    const created = await request(app).post("/commercial-contacts/user-names").set(headers).send({ name: "aziz" });
    expect(created.status).toBe(201);
    expect(created.body.profile.name).toBe("aziz");

    // 4. Présent en base, rattaché au compte
    const rows = await CommercialProfile.findAll({ where: { userId: aziz.id } });
    expect(rows.map((r) => r.name)).toEqual(["aziz"]);

    // 5-6. Déconnexion puis reconnexion
    await request(app).post("/auth/logout").set(headers);
    headers = await signIn(aziz);

    // 7. aziz apparaît dans la liste, une seule fois
    const names = await listNames(headers);
    expect(names.filter((n) => n.toLowerCase() === "aziz")).toEqual(["aziz"]);

    // 8. Sélection d'aziz → reconnue par le backend
    const selected = await request(app)
      .post("/commercial-contacts/select-commercial")
      .set(headers)
      .send({ commercialName: "aziz" });
    expect(selected.status).toBe(200);

    // 9. Actualisation : toujours là
    expect(await listNames(headers)).toContain("aziz");
  });

  test("pas de doublon : nouvelle confirmation (casse/espaces différents) → 200, une seule ligne", async () => {
    const res = await request(app).post("/commercial-contacts/user-names").set(tokenAuth(aziz)).send({ name: "  Aziz " });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.profile.name).toBe("aziz");
    expect(await CommercialProfile.count({ where: { userId: aziz.id } })).toBe(1);
  });

  test("un nom prédéfini n'est jamais recréé en base", async () => {
    const res = await request(app).post("/commercial-contacts/user-names").set(tokenAuth(aziz)).send({ name: "Najeh" });
    expect(res.status).toBe(200);
    expect(res.body.profile.name).toBe("najeh");
    expect(await CommercialProfile.count({ where: { userId: aziz.id } })).toBe(1);
  });

  test.each([[""], ["   "], [null], [123], ["x".repeat(121)]])("nom invalide %p → 400", async (name) => {
    const res = await request(app).post("/commercial-contacts/user-names").set(tokenAuth(aziz)).send({ name });
    expect(res.status).toBe(400);
  });

  test("le profil d'aziz n'est pas visible ni sélectionnable par un autre compte", async () => {
    const unique = `profil-prive-${RUN_ID}`;
    await request(app).post("/commercial-contacts/user-names").set(tokenAuth(aziz)).send({ name: unique }).expect(201);

    expect(await listNames(tokenAuth(otherCommercial))).not.toContain(unique);
    const sel = await request(app)
      .post("/commercial-contacts/select-commercial")
      .set(tokenAuth(otherCommercial))
      .send({ commercialName: unique });
    expect(sel.status).toBe(404);
  });

  test("le rôle commercial peut aussi enregistrer son profil", async () => {
    const res = await request(app)
      .post("/commercial-contacts/user-names")
      .set(tokenAuth(otherCommercial))
      .send({ name: `commercial-${RUN_ID}` });
    expect(res.status).toBe(201);
  });

  test("un compte non commercial hors domaine ne peut pas créer de profil (403, contrôle serveur)", async () => {
    const res = await request(app).post("/commercial-contacts/user-names").set(tokenAuth(otherDomain)).send({ name: "intrus" });
    expect(res.status).toBe(403);
    expect(await CommercialProfile.count({ where: { userId: otherDomain.id } })).toBe(0);
  });

  test("sans jeton → 401", async () => {
    const res = await request(app).post("/commercial-contacts/user-names").send({ name: "x" });
    expect(res.status).toBe(401);
  });
});
