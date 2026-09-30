"use strict";

// "Pression air comprimé" (Contrôle Machine PROMESH → ligne Process
// "Pression d'air comprimé", colonne valeurP1 VARCHAR(50)) — saisie libre
// réellement enregistrée, plus jamais écrasée par une copie de `air`.
// Scénario du ticket (5 → 6), relu dans PostgreSQL à chaque étape.

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
  verifyConnection: jest.fn().mockResolvedValue({ ok: true }),
  maskEmail: (e) => e,
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const bcrypt = require("bcrypt");
const { QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");

const RUN_ID = Date.now();
const PASSWORD = "StrongPass123!";
const B = "controle_08h20";
const P = "Pression d'air comprimé";
const DATE = "2026-09-30";

const createdUsers = [];
const createdFiches = [];
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function pressionInDb(id) {
  const [r] = await sequelize.query(
    `SELECT "valeurP1" FROM por_promesh_process_control WHERE "porPromeshId" = :id AND bloc = :b AND parametre = :p`,
    { replacements: { id, b: B, p: P }, type: QueryTypes.SELECT }
  );
  return r?.valeurP1;
}

// Tableau Process tel que l'envoie le formulaire (lignes actives du bloc 08h20).
const processWith = (pression) => [
  { bloc: B, parametre: "Diamètre de bar", valeurP1: "8" },
  { bloc: B, parametre: P, valeurP1: pression },
];

describe("PROMESH — Pression air comprimé (input texte)", () => {
  let token;
  let id;

  beforeAll(async () => {
    const u = await User.create({ email: `promesh-pression-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash(PASSWORD, 12), isActive: true, role: "responsable_logistique_achat" });
    createdUsers.push(u.id);
    token = (await request(app).post("/auth/signin").send({ email: u.email, password: PASSWORD })).body.accessToken;
  }, 20000);

  afterAll(async () => {
    if (createdFiches.length) await sequelize.query(`DELETE FROM por_promesh WHERE id IN (:ids)`, { replacements: { ids: createdFiches } });
    await User.destroy({ where: { id: createdUsers } });
    await sequelize.close();
  });

  test("1-4 — création avec pression = 5 : enregistrée, relue à la réouverture (jamais remplacée par « Pression d'air »)", async () => {
    const res = await request(app)
      .post("/por-promesh")
      .set(auth(token))
      .send({ machine: "1", poste: "matin", dateProduction: DATE, air: "> 6 bars", productionM2: 1000, processControl: processWith("5") });
    expect(res.status).toBe(201);
    id = res.body.data.id;
    createdFiches.push(id);
    expect(await pressionInDb(id)).toBe("5"); // avant : écrasée par "> 6 bars"

    const reopened = await request(app).get(`/por-promesh/${id}`).set(auth(token));
    const row = reopened.body.data.processControl.find((r) => r.bloc === B && r.parametre === P);
    expect(row.valeurP1).toBe("5"); // valeur affichée dans l'input
  });

  test("5-8 — modification 5 → 6 (UPDATE) : persistée et relue", async () => {
    const res = await request(app).put(`/por-promesh/${id}`).set(auth(token)).send({ processControl: processWith("6") });
    expect(res.status).toBe(200);
    expect(await pressionInDb(id)).toBe("6");
    const reopened = await request(app).get(`/por-promesh/${id}`).set(auth(token));
    expect(reopened.body.data.processControl.find((r) => r.parametre === P).valeurP1).toBe("6");
    // ÉTAPE 10 — UPDATE sur le MÊME id, aucune nouvelle fiche créée.
    expect(res.body.data.id).toBe(id);
    const [{ n }] = await sequelize.query(`SELECT count(*)::int n FROM por_promesh WHERE "createdBy" = :u`, { replacements: { u: createdUsers[0] }, type: QueryTypes.SELECT });
    expect(n).toBe(1);
  });

  test("valeurs textuelles acceptées (« 5.5 », « > 6 », « < 6 ») et champ vide sans erreur", async () => {
    for (const v of ["5.5", "> 6", "< 6", ""]) {
      const res = await request(app).put(`/por-promesh/${id}`).set(auth(token)).send({ processControl: processWith(v) });
      expect(res.status).toBe(200);
      expect(await pressionInDb(id)).toBe(v);
    }
  });

  test("modifier « Pression d'air » (Contrôle Machine) ne touche plus la pression saisie", async () => {
    await request(app).put(`/por-promesh/${id}`).set(auth(token)).send({ processControl: processWith("6") });
    const res = await request(app).put(`/por-promesh/${id}`).set(auth(token)).send({ air: "< 6 bars" });
    expect(res.status).toBe(200);
    expect(await pressionInDb(id)).toBe("6");
  });

  test("ancienne fiche (« > 6 bars » recopié autrefois) : valeur conservée et toujours lisible", async () => {
    const res = await request(app).post("/por-promesh").set(auth(token)).send({ machine: "2", poste: "nuit", dateProduction: DATE, processControl: processWith("> 6 bars") });
    const oldId = res.body.data.id;
    createdFiches.push(oldId);
    expect((await request(app).put(`/por-promesh/${oldId}`).set(auth(token)).send({ observationsGenerales: "x" })).status).toBe(200);
    expect(await pressionInDb(oldId)).toBe("> 6 bars");
  });

  test("9 — Production Summary non impacté", async () => {
    const res = await request(app).get(`/production-records/summary?type=promesh&startDate=${DATE}&endDate=${DATE}&period=custom&status=all`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.promesh.rows.find((r) => r.id === `promesh:${id}`)).toMatchObject({ quantite: 1000, machine: "1" });
  });
});
