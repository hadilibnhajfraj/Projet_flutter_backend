"use strict";

// Contrôle Machine PROMESH — paramètres retirés le 2026-09-30 :
// "Température d'eau" (temperatureEau), "État disque de coupe (Machine)"
// (etatDisqueCoupe) et les lignes Process "Température d'eau",
// "Etat disque de coupe", "Fuite d'eau". Vérifie (relecture PostgreSQL)
// que les nouvelles créations/modifications ne les utilisent plus et que
// l'historique des anciennes fiches n'est jamais perdu.

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
const RETIRED = ["Température d'eau", "Etat disque de coupe", "Fuite d'eau"];
const B = "controle_08h20";

const createdUsers = [];
const createdFiches = [];

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function row(id) {
  const [r] = await sequelize.query(
    `SELECT "temperatureEau"::text AS "temperatureEau", "etatDisqueCoupe", air, "fluideVisuel", "temperaturePistons"::text AS "temperaturePistons"
       FROM por_promesh WHERE id = :id`,
    { replacements: { id }, type: QueryTypes.SELECT }
  );
  return r;
}

async function processRows(id) {
  const rows = await sequelize.query(
    `SELECT bloc, parametre, "valeurP1", "corP1" FROM por_promesh_process_control WHERE "porPromeshId" = :id ORDER BY parametre`,
    { replacements: { id }, type: QueryTypes.SELECT }
  );
  return Object.fromEntries(rows.map((r) => [`${r.bloc}|${r.parametre}`, r]));
}

describe("PROMESH — paramètres Contrôle Machine retirés", () => {
  let token;
  let oldFicheId;

  beforeAll(async () => {
    const u = await User.create({ email: `promesh-retired-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash(PASSWORD, 12), isActive: true, role: "responsable_logistique_achat" });
    createdUsers.push(u.id);
    token = (await request(app).post("/auth/signin").send({ email: u.email, password: PASSWORD })).body.accessToken;
  }, 20000);

  afterAll(async () => {
    if (createdFiches.length) await sequelize.query(`DELETE FROM por_promesh WHERE id IN (:ids)`, { replacements: { ids: createdFiches } });
    await User.destroy({ where: { id: createdUsers } });
    await sequelize.close();
  });

  test("ancienne fiche (payload ancien client) : les 3 paramètres sont encore acceptés et stockés", async () => {
    const res = await request(app)
      .post("/por-promesh")
      .set(auth(token))
      .send({
        machine: "1",
        poste: "matin",
        dateProduction: "2026-09-30",
        air: "> 6 bars",
        fluideVisuel: "Absence",
        temperatureEau: 52,
        etatDisqueCoupe: "NOK",
        temperaturePistons: 170,
        processControl: [
          { bloc: B, parametre: "Diamètre de bar", valeurP1: "8" },
          { bloc: B, parametre: "Température d'eau", valeurP1: "52" },
          { bloc: B, parametre: "Etat disque de coupe", valeurP1: "NOK" },
          { bloc: B, parametre: "Fuite d'eau", valeurP1: "Non" },
        ],
      });
    expect(res.status).toBe(201);
    oldFicheId = res.body.data.id;
    createdFiches.push(oldFicheId);
    expect(await row(oldFicheId)).toMatchObject({ temperatureEau: "52.00", etatDisqueCoupe: "NOK" });
    const pc = await processRows(oldFicheId);
    // Plus dérivées : les valeurs envoyées restent telles quelles.
    expect(pc[`${B}|Température d'eau`].valeurP1).toBe("52");
    expect(pc[`${B}|Etat disque de coupe`].valeurP1).toBe("NOK");
    expect(pc[`${B}|Fuite d'eau`].valeurP1).toBe("Non");
  });

  test("TEST 5/6/8 — UPDATE nouveau client (Process SANS lignes retirées) : actifs sauvegardés, historique conservé", async () => {
    const res = await request(app)
      .put(`/por-promesh/${oldFicheId}`)
      .set(auth(token))
      .send({
        temperaturePistons: 175,
        processControl: [{ bloc: B, parametre: "Diamètre de bar", valeurP1: "10" }],
      });
    expect(res.status).toBe(200);

    const r = await row(oldFicheId);
    expect(Number(r.temperaturePistons)).toBe(175); // paramètre actif sauvegardé (colonne DOUBLE)
    expect(r).toMatchObject({ temperatureEau: "52.00", etatDisqueCoupe: "NOK", air: "> 6 bars", fluideVisuel: "Absence" }); // jamais remis à null

    const pc = await processRows(oldFicheId);
    expect(pc[`${B}|Diamètre de bar`].valeurP1).toBe("10");
    for (const p of RETIRED) expect(pc[`${B}|${p}`]).toBeDefined(); // lignes historiques NON supprimées
    expect(pc[`${B}|Température d'eau`].valeurP1).toBe("52");
    // "Pression d'air comprimé" n'est plus recopiée depuis air (saisie libre, 2026-09-30).
    expect(pc[`${B}|Pression d'air comprimé`]).toBeUndefined();
  });

  test("UPDATE sans tableau Process : lignes retirées intactes, aucune ligne recréée", async () => {
    const before = await processRows(oldFicheId);
    expect((await request(app).put(`/por-promesh/${oldFicheId}`).set(auth(token)).send({ observationsGenerales: "ok" })).status).toBe(200);
    const after = await processRows(oldFicheId);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const p of RETIRED) expect(after[`${B}|${p}`].valeurP1).toBe(before[`${B}|${p}`].valeurP1);
  });

  test("TEST 3/4/7 — CREATE nouveau client (sans les 3 paramètres) : 201, rien n'est généré pour eux", async () => {
    const res = await request(app)
      .post("/por-promesh")
      .set(auth(token))
      .send({
        machine: "2",
        poste: "nuit",
        dateProduction: "2026-09-30",
        air: "< 6 bars",
        niveauBainEau: "Bien",
        temperaturePistons: 160,
        etatPistons: "Propre",
        fluideVisuel: "Présence",
        processControl: [{ bloc: B, parametre: "Diamètre de bar", valeurP1: "8" }],
      });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    createdFiches.push(id);
    expect(await row(id)).toMatchObject({ temperatureEau: null, etatDisqueCoupe: null, fluideVisuel: "Présence" });
    const pc = await processRows(id);
    for (const p of RETIRED) expect(pc[`${B}|${p}`]).toBeUndefined(); // plus aucune ligne "Fuite d'eau" dérivée de fluideVisuel
    expect(pc[`${B}|Pression d'air comprimé`]).toBeUndefined(); // plus générée depuis air
  });

  test("TEST 9/10 — ancienne fiche toujours lisible (GET, détail Production Records, Summary)", async () => {
    const get = await request(app).get(`/por-promesh/${oldFicheId}`).set(auth(token));
    expect(get.status).toBe(200);
    expect(get.body.data.temperatureEau).toBe("52.00"); // donnée historique toujours servie

    const detail = await request(app).get(`/production-records/promesh:${oldFicheId}`).set(auth(token));
    expect(detail.status).toBe(200);

    const summary = await request(app).get(`/production-records/summary?type=promesh&startDate=2026-09-30&endDate=2026-09-30&period=custom&status=all`).set(auth(token));
    expect(summary.status).toBe(200);
    expect(summary.body.data.promesh.rows.some((r) => r.id === `promesh:${oldFicheId}`)).toBe(true);
  });
});
