"use strict";

// Responsable logistique : compte, connexion et accès — BASE RÉELLE, vraie
// application Express (auth, moduleAccessGuard, requireRole, routes).
//
//  - Le compte réel responsable_logistique@cbi-tunisia.com existe une seule
//    fois, rôle responsable_logistique_achat, actif, mot de passe haché
//    (bcrypt) : il n'est jamais modifié par ce test.
//  - Connexion : son mot de passe n'étant pas connu du test, le parcours
//    POST /auth/signin → JWT est vérifié avec un compte TEMPORAIRE du même
//    rôle (mot de passe aléatoire, haché avec bcrypt comme l'application),
//    supprimé en fin de test.
//  - Accès du compte réel : jeton d'accès signé avec la même clé et le même
//    contenu ({sub, email, role}) que celui émis à la connexion.
// Aucun jeton ni mot de passe n'est jamais affiché.

jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const request = require("supertest");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken, verifyAccessToken } = require("../src/utils/tokens");
const User = require("../src/models/User");

const REAL = "responsable_logistique@cbi-tunisia.com";
const TEMP = `test.logistique.${crypto.randomBytes(4).toString("hex")}@cbi-tunisia.com`;
const TEMP_PASSWORD = `Aa1!${crypto.randomBytes(12).toString("hex")}`;

let real;
let realBefore;

beforeAll(async () => {
  real = await User.findOne({ where: { email: REAL } });
  realBefore = real ? { role: real.role, isActive: real.isActive, passwordHash: real.passwordHash, updatedAt: String(real.updatedAt) } : null;
  await User.create({
    email: TEMP,
    role: "responsable_logistique_achat",
    passwordHash: await bcrypt.hash(TEMP_PASSWORD, 12), // même hachage que l'application
    isActive: true,
  });
});

afterAll(async () => {
  await User.destroy({ where: { email: TEMP } });
  // Compte réel jamais modifié.
  const after = await User.findOne({ where: { email: REAL } });
  expect({ role: after.role, isActive: after.isActive, passwordHash: after.passwordHash, updatedAt: String(after.updatedAt) }).toEqual(realBefore);
  await sequelize.close();
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const realToken = () => signAccessToken({ sub: real.id, email: real.email, role: real.role });

describe("Compte du responsable logistique", () => {
  test("existe une seule fois, rôle reconnu par le backend, actif, mot de passe haché", async () => {
    expect(await User.count({ where: { email: REAL } })).toBe(1);
    expect(real.role).toBe("responsable_logistique_achat");
    expect(User.rawAttributes.role.values).toContain(real.role); // valeur de l'enum, jamais inventée
    expect(real.isActive).toBe(true);
    expect(real.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt, jamais en clair
  });
});

describe("Connexion (compte temporaire du même rôle)", () => {
  let accessToken;

  test("POST /auth/signin : JWT valide, identité et rôle réels, jamais Super Admin", async () => {
    const res = await request(app).post("/auth/signin").send({ email: TEMP, password: TEMP_PASSWORD });
    expect(res.status).toBe(200);
    accessToken = res.body.accessToken;
    expect(typeof accessToken).toBe("string");
    const payload = verifyAccessToken(accessToken);
    expect(payload).toMatchObject({ email: TEMP, role: "responsable_logistique_achat" });
    expect(["admin", "superadmin", "superadmin2"]).not.toContain(payload.role);
  });

  test("mauvais mot de passe : refusé", async () => {
    const res = await request(app).post("/auth/signin").send({ email: TEMP, password: "Aa1!mauvais-mot-de-passe" });
    expect(res.status).toBe(401);
  });

  test("jeton transmis : l'utilisateur est identifié ; sans jeton : 401 « Missing token »", async () => {
    const me = await request(app).get("/production-fiche-approvals/permissions").set(bearer(accessToken));
    expect(me.status).toBe(200);
    const none = await request(app).get("/archive-requests/my");
    expect(none.status).toBe(401);
    expect(none.body.message).toBe("Missing token");
  });
});

describe("Accès du compte réel (jeton identique à celui émis à la connexion)", () => {
  test("/archive-requests/my : module d'archivage des projets CRM, non autorisé pour ce rôle (403, contrôle conservé)", async () => {
    const res = await request(app).get("/archive-requests/my").set(bearer(realToken()));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
  });

  test("ses fonctionnalités : archivage / désarchivage et autorisations Production, fiches, matières premières, notifications", async () => {
    const t = realToken();
    for (const path of [
      "/production-draft-archive/requests", // demandes de désarchivage des fiches
      "/production-draft-archive/archived-sheets", // fiches archivées
      "/production-compliance/requests", // demandes d'autorisation (dates antérieures)
      "/production-fiche-approvals?status=all",
      "/raw-material-requests",
      "/notifications",
    ]) {
      const res = await request(app).get(path).set(bearer(t));
      expect([path, res.status]).toEqual([path, 200]);
    }
    expect((await request(app).get("/production-fiche-approvals/permissions").set(bearer(t))).body.data).toMatchObject({ canDecide: true });
    expect((await request(app).get("/raw-material-requests/permissions").set(bearer(t))).body.data).toMatchObject({ canValidate: true });
    // Jamais les écrans Super Admin.
    expect((await request(app).get("/archive-requests/admin").set(bearer(t))).status).toBe(403);
  });
});
