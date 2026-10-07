"use strict";

// Module CONTRÔLE QUALITÉ — PROMESH : fiches qualité INDÉPENDANTES de la
// production.
//
// Contrôle Qualité → PROMESH → Machine → Nouveau contrôle crée directement une
// fiche qualité : aucune fiche de production n'est requise, la date n'a pas à
// correspondre à une production, et une association éventuelle reste
// facultative et informative. Chaque machine a ses propres fiches ; seules les
// fiches des comptes controle_qualite apparaissent ; brouillon modifiable /
// supprimable, validé en lecture seule ; plusieurs prélèvements par fiche.
//
// Aucune fiche de production n'est créée ni modifiée. Fiches qualité créées à
// une date lointaine (2036, aucune production), supprimées en afterAll.

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
const { QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const PRODUCTION_EMAIL = "responsable_logistique@cbi-tunisia.com";
const PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const DAY = "2036-03-14"; // aucune fiche de production à cette date
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

describe("Contrôle Qualité PROMESH — fiches indépendantes de la production", () => {
  let qc;
  let production;
  let fiche;
  let productionCounts;

  const post = (path, body, token = qc) => request(app).post(path).set(auth(token)).send(body);
  const put = (path, body) => request(app).put(path).set(auth(qc)).send(body);
  const get = (path, token = qc) => request(app).get(path).set(auth(token));
  const del = (path) => request(app).delete(path).set(auth(qc));
  const ids = async (query) => (await get(`/quality-control?limit=100&${query}`)).body.data.map((c) => c.id);
  const countProduction = async () => (await sql(`SELECT (SELECT COUNT(*)::int FROM por_promesh) AS promesh, (SELECT COUNT(*)::int FROM industrial_records) AS records, (SELECT MAX("updatedAt") FROM por_promesh) AS touched`))[0];

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: PASSWORD })).body.accessToken;
    production = (await request(app).post("/auth/signin").send({ email: PRODUCTION_EMAIL, password: PASSWORD })).body.accessToken;
    productionCounts = await countProduction();
    // Précondition du test : aucune production PROMESH ce jour-là.
    const [{ n }] = await sql(`SELECT COUNT(*)::int n FROM por_promesh WHERE "dateProduction" = :d`, { d: DAY });
    expect(n).toBe(0);
  }, 30000);

  afterAll(async () => {
    if (created.length) {
      const r = { replacements: { ids: created } };
      await sequelize.query(`DELETE FROM notifications WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_history WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_items WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_readings WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_controls WHERE id IN (:ids)`, r);
    }
    await sequelize.close();
  }, 30000);

  test("Nouveau contrôle PROMESH Machine 3 : fiche créée directement, sans aucune fiche de production", async () => {
    // La recherche de production ne bloque rien : simple information.
    const match = await get(`/quality-control/production-match?productionType=PROMESH&machine=3&productionDate=${DAY}&poste=matin`);
    expect(match.status).toBe(200);
    expect(match.body.data).toMatchObject({ matched: false, reason: "NO_PRODUCTION_SHEET" });

    const res = await post("/quality-control", { productionType: "PROMESH", machine: "3", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [{ parameterKey: "temperature_machine", value: "20", status: "CONFORME" }] } });
    expect(res.status).toBe(201);
    fiche = res.body.data;
    created.push(fiche.id);
    expect(fiche).toMatchObject({ productionType: "PROMESH", machine: "3", isValidated: false, productionRecordId: null, productionRecordRef: null, manufacturingOrder: null, controllerEmail: QC_EMAIL });
    expect(fiche.reference).toMatch(/^QC-PROMESH-\d{6}$/);
    expect(fiche.readings).toHaveLength(1);

    // Sans poste ni date de production renseignés : toujours possible.
    const bare = await post("/quality-control", { productionType: "PROMESH", machine: "4", reading: { readingTime: "09:00", items: [] } });
    expect(bare.status).toBe(201);
    created.push(bare.body.data.id);
    expect(bare.body.data).toMatchObject({ machine: "4", productionRecordId: null });
  });

  test("la date du contrôle n'a pas à correspondre à une production : date et poste modifiables librement", async () => {
    const moved = await put(`/quality-control/${fiche.id}`, { productionDate: "2036-03-15", poste: "soir" });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ productionDate: "2036-03-15", poste: "soir", productionRecordId: null });
    const back = await put(`/quality-control/${fiche.id}`, { productionDate: DAY, poste: "matin" });
    expect(back.status).toBe(200);
    // Lot : saisi par le contrôleur quand aucune production ne le fournit.
    const lot = await put(`/quality-control/${fiche.id}`, { lot: "LOT-QC-01" });
    expect(lot.body.data).toMatchObject({ lot: "LOT-QC-01", lotAuto: false });
  });

  test("chaque machine PROMESH a ses propres fiches ; aucune fiche d'une autre machine ou de PROBAR", async () => {
    expect(await ids("productionType=PROMESH&machine=3")).toContain(fiche.id);
    for (const machine of ["1", "2", "4"]) expect(await ids(`productionType=PROMESH&machine=${machine}`)).not.toContain(fiche.id);
    expect(await ids("productionType=PROBAR&machine=3")).not.toContain(fiche.id);
    const m3 = (await get("/quality-control?limit=100&productionType=PROMESH&machine=3")).body.data;
    expect(m3.every((c) => c.productionType === "PROMESH" && c.machine === "3")).toBe(true);
  });

  test("créateur : seules les fiches des comptes controle_qualite ; un compte de production ne crée ni ne voit rien ici", async () => {
    const denied = await post("/quality-control", { productionType: "PROMESH", machine: "3", productionDate: DAY, poste: "soir", reading: { readingTime: "08:00", items: [] } }, production);
    expect(denied.status).toBe(403);
    expect((await get("/quality-control?productionType=PROMESH", production)).status).toBe(403);
    // Toutes les fiches qualité PROMESH appartiennent à un compte controle_qualite.
    const authors = await sql(`SELECT DISTINCT u.role FROM quality_controls c JOIN users u ON u.id = c."controllerUserId" WHERE c."deletedAt" IS NULL AND c."productionType" = 'PROMESH'`);
    expect(authors.map((a) => a.role)).toEqual(["controle_qualite"]);
    const listed = (await get("/quality-control?limit=100&productionType=PROMESH")).body.data;
    expect(listed.every((c) => c.controllerEmail === QC_EMAIL)).toBe(true);
  });

  test("plusieurs prélèvements indépendants : chacun ses propres valeurs des 8 contrôles machine", async () => {
    const r2 = await post(`/quality-control/${fiche.id}/readings`, { readingTime: "11:00", items: [{ parameterKey: "temperature_machine", value: "22", status: "NON_CONFORME", remark: "à surveiller" }] });
    const r3 = await post(`/quality-control/${fiche.id}/readings`, { readingTime: "14:00", items: [{ parameterKey: "temperature_machine", value: "24", status: "CONFORME" }] });
    expect([r2.status, r3.status]).toEqual([201, 201]);
    const c = r3.body.data;
    expect(c.readings.map((r) => [r.step, r.readingTime])).toEqual([[1, "08:00"], [2, "11:00"], [3, "14:00"]]);
    const bar = c.readings.map((r) => r.items.find((i) => i.parameterKey === "temperature_machine"));
    expect(bar.map((i) => [i.value, i.status])).toEqual([["20", "CONFORME"], ["22", "NON_CONFORME"], ["24", "CONFORME"]]);
    expect(bar[1].remark).toBe("à surveiller");
    for (const r of c.readings) expect(r.items).toHaveLength(8);
    // PROMESH : contrôle produit au niveau fiche (une fois), jamais dans un prélèvement.
    expect(c.physicalParameters).toHaveLength(7);
    expect(c.specificParameters).toEqual([]);
  });

  test("BROUILLON : modifiable et supprimable ; VALIDÉ : lecture seule, ni modification ni suppression", async () => {
    // Brouillon supprimable.
    const draft = await post("/quality-control", { productionType: "PROMESH", machine: "2", productionDate: DAY, poste: "soir", reading: { readingTime: "08:00", items: [] } });
    expect(draft.status).toBe(201);
    created.push(draft.body.data.id);
    expect((await del(`/quality-control/${draft.body.data.id}`)).status).toBe(200);
    expect(await ids("productionType=PROMESH&machine=2")).not.toContain(draft.body.data.id);

    // Validation, toujours sans production.
    const v = await post(`/quality-control/${fiche.id}/validate`, { status: "NON_CONFORME" });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ isValidated: true, status: "NON_CONFORME", productionRecordId: null });
    expect((await put(`/quality-control/${fiche.id}`, { remark: "x" })).status).toBe(403);
    expect((await post(`/quality-control/${fiche.id}/readings`, { readingTime: "17:00", items: [] })).status).toBe(403);
    expect((await del(`/quality-control/${fiche.id}`)).status).toBe(403);
    expect((await get(`/quality-control/${fiche.id}`)).body.data.readings).toHaveLength(3);
  });

  test("le module Production n'est pas touché : aucune fiche de production créée ni modifiée", async () => {
    expect(await countProduction()).toEqual(productionCounts);
  });
});
