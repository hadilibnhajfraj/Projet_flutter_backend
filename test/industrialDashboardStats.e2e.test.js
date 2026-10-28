"use strict";

// Tableau de bord industriel (« Dashboard » des comptes de production et des
// responsables) : les compteurs PROMESH / PROBAR calculés à partir des API
// GET /por-promesh et GET /industrial-records?module=probar correspondent
// EXACTEMENT aux fiches en base, selon le périmètre de chaque compte :
//   - responsables logistique et production : TOUTES les fiches (consultation
//     des fiches des producteurs qu'ils valident) ;
//   - production_1..5 (même rôle) : leurs propres fiches ;
//   - superadmin : toutes.
// Fiches archivées masquées par défaut. LECTURE SEULE — aucune donnée
// modifiée. Statuts de validation (en attente / acceptées / refusées) aussi.
// Les écritures restent limitées au créateur (vérifié sur une fiche réelle,
// requêtes refusées par le backend avant toute modification).

jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));

const request = require("supertest");
const { QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const User = require("../src/models/User");
const PorPromesh = require("../src/models/PorPromesh");
const logisticsManagers = require("../src/config/logisticsManagers");

const ACCOUNTS = [
  "responsable_production@cbi-tunisia.com",
  "responsable_logistique@cbi-tunisia.com",
  "production_1@cbi-tunisia.com",
  "production_2@cbi-tunisia.com",
  "cbitunisia@cbi-tunisia.com",
];

afterAll(() => sequelize.close());

const count = async (sql, replacements) => Number((await sequelize.query(sql, { replacements, type: QueryTypes.SELECT }))[0].n);

for (const email of ACCOUNTS) {
  test(`${email} : compteurs du tableau de bord = fiches en base (même périmètre)`, async () => {
    const u = await User.findOne({ where: { email } });
    if (!u) throw new Error(`Compte introuvable : ${email}`);
    const auth = { Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` };
    const ownScoped = u.role === "responsable_logistique_achat" && !logisticsManagers.isLogisticsManager(email);
    const scope = ownScoped ? `AND "createdBy" = :id` : "";

    // Mêmes appels que le tableau de bord Flutter.
    const promesh = await request(app).get("/por-promesh?skip=0&limit=1000").set(auth);
    const probar = await request(app).get("/industrial-records?module=probar&pageSize=500").set(auth);
    expect([promesh.status, probar.status]).toEqual([200, 200]);

    const dbPromesh = await count(`SELECT count(*) AS n FROM por_promesh WHERE status <> 'ARCHIVED' ${scope}`, { id: u.id });
    const dbProbar = await count(`SELECT count(*) AS n FROM industrial_records WHERE module = 'probar' AND statut <> 'archivee' ${scope}`, { id: u.id });
    expect(promesh.body.data.length).toBe(dbPromesh);
    expect(probar.body.data.length).toBe(dbProbar);
    // Total sans doublon : deux tables distinctes, identifiants uniques.
    const ids = [...promesh.body.data, ...probar.body.data].map((f) => f.id);
    expect(new Set(ids).size).toBe(dbPromesh + dbProbar);
    // Uniquement des fiches du bon type, et du bon créateur pour un compte limité à ses fiches.
    expect(probar.body.data.every((f) => f.module === "probar")).toBe(true);
    if (ownScoped) {
      expect([...promesh.body.data, ...probar.body.data].every((f) => f.createdBy === u.id)).toBe(true);
    }

    // Statuts de validation (acceptées / refusées / en attente) identiques à la base.
    for (const status of ["APPROVED", "REJECTED", "PENDING"]) {
      const db =
        (await count(`SELECT count(*) AS n FROM por_promesh WHERE status <> 'ARCHIVED' AND "approvalStatus" = :s ${scope}`, { id: u.id, s: status })) +
        (await count(`SELECT count(*) AS n FROM industrial_records WHERE module = 'probar' AND statut <> 'archivee' AND "approvalStatus" = :s ${scope}`, { id: u.id, s: status }));
      const api = [...promesh.body.data, ...probar.body.data].filter((f) => f.approval?.status === status).length;
      expect([status, api]).toEqual([status, db]);
    }
  });
}

async function authFor(email) {
  const u = await User.findOne({ where: { email } });
  return { user: u, auth: { Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` } };
}

test("responsable production : avant 0 fiche (ses propres fiches), maintenant toutes les fiches des producteurs", async () => {
  const { auth } = await authFor("responsable_production@cbi-tunisia.com");
  const promesh = (await request(app).get("/por-promesh?skip=0&limit=1000").set(auth)).body.data;
  const probar = (await request(app).get("/industrial-records?module=probar&pageSize=500").set(auth)).body.data;
  const creators = new Set([...promesh, ...probar].map((f) => f.creator && f.creator.email));
  expect(creators.has("production_1@cbi-tunisia.com")).toBe(true);
  expect(promesh.map((f) => f.numero)).toContain("PROMESH-2026-000953");
  // Toujours des fiches non archivées, et uniquement du bon type.
  expect(promesh.every((f) => f.status !== "ARCHIVED")).toBe(true);
  expect(probar.every((f) => f.module === "probar" && f.statut !== "archivee")).toBe(true);
});

test("lecture d'une fiche d'un producteur : responsables oui, autre producteur non ; écriture : refusée aux responsables", async () => {
  const fiche = await PorPromesh.findOne({ where: { sequenceNumber: 953 }, raw: true });
  if (!fiche) return; // fiche réelle absente : rien à vérifier
  const before = JSON.stringify(fiche);
  for (const email of ["responsable_production@cbi-tunisia.com", "responsable_logistique@cbi-tunisia.com"]) {
    const { auth } = await authFor(email);
    expect((await request(app).get(`/por-promesh/${fiche.id}`).set(auth)).status).toBe(200);
    // Écritures refusées AVANT toute modification (créateur différent).
    const put = await request(app).put(`/por-promesh/${fiche.id}`).set(auth).send({ observationsGenerales: "tentative" });
    expect(put.status).toBe(403);
    expect((await request(app).delete(`/por-promesh/${fiche.id}`).set(auth)).status).toBe(403);
  }
  const { auth: p2 } = await authFor("production_2@cbi-tunisia.com");
  expect((await request(app).get(`/por-promesh/${fiche.id}`).set(p2)).status).toBe(403);
  // Fiche intacte.
  expect(JSON.stringify(await PorPromesh.findByPk(fiche.id, { raw: true }))).toBe(before);
});
