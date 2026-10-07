"use strict";

// Module CONTRÔLE QUALITÉ — lot, ordre de fabrication et association
// AUTOMATIQUE à la fiche de production (ligne + machine + date de production
// + poste). Les fiches de production utilisées sont créées par ce test à une
// date lointaine (aucune fiche réelle lue ni modifiée) puis supprimées, comme
// les contrôles créés.

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
const PorPromesh = require("../src/models/PorPromesh");
const IndustrialRecord = require("../src/models/IndustrialRecord");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const RUN_ID = Date.now();
const DAY = "2032-05-10"; // fiches de production du test
const EMPTY_DAY = "2032-05-11"; // aucune fiche de production
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const createdControls = [];
const promeshIds = [];
const probarIds = [];
let adminId;

async function dbRow(id) {
  const [r] = await sequelize.query(
    `SELECT "productionRecordId", "ficheNumero", lot, "manufacturingOrder", poste, "productionDate"::text AS "productionDate", "validatedAt"
       FROM quality_controls WHERE id = :id`,
    { replacements: { id }, type: QueryTypes.SELECT }
  );
  return r;
}

describe("Contrôle Qualité — lot, ordre de fabrication, association automatique à la production", () => {
  let qc;
  const fiche = {};

  async function create(body) {
    const res = await request(app).post("/quality-control").set(auth(qc)).send(body);
    if (res.body.data?.id) createdControls.push(res.body.data.id);
    return res;
  }

  // Une seule fiche OUVERTE par machine / date / poste : chaque test libère
  // sa fiche (brouillon supprimé) pour le suivant.
  const drop = (res) => request(app).delete(`/quality-control/${res.body.data.id}`).set(auth(qc));

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
    const admin = await User.create({ email: `qc-prod-admin-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash("StrongPass123!", 12), isActive: true, role: "superadmin" });
    adminId = admin.id;

    const promesh = async (machine, poste, extra = {}) => {
      const f = await PorPromesh.create({ machine, poste, dateProduction: DAY, createdBy: adminId, status: "VALIDE", ...extra });
      promeshIds.push(f.id);
      return f.id;
    };
    const probar = async (machine, poste) => {
      const f = await IndustrialRecord.create({ module: "probar", machine, poste, dateFiche: DAY, createdBy: adminId, statut: "validee" });
      probarIds.push(f.id);
      return f.id;
    };
    fiche.m1Matin = await promesh("1", "matin");
    fiche.m1Soir = await promesh("1", "nuit"); // la production nomme « nuit » le poste du soir
    fiche.m2Matin = await promesh("2", "matin");
    fiche.probarM1Matin = await probar("1", "matin");
    fiche.probarM2Soir = await probar("2", "nuit");
    // Doublon : deux fiches PROMESH machine 3, même date, même poste.
    await promesh("3", "matin");
    await promesh("3", "matin");
    // Fiche archivée (brouillon expiré) : jamais associée.
    const archived = await promesh("4", "matin");
    await sequelize.query(`UPDATE por_promesh SET status = 'ARCHIVED', "archivedAt" = NOW() WHERE id = :id`, { replacements: { id: archived } });
  }, 30000);

  afterAll(async () => {
    if (createdControls.length) {
      const r = { replacements: { ids: createdControls } };
      await sequelize.query(`DELETE FROM notifications WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_history WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_items WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_controls WHERE id IN (:ids)`, r);
    }
    if (promeshIds.length) await sequelize.query(`DELETE FROM por_promesh WHERE id IN (:ids)`, { replacements: { ids: promeshIds } });
    if (probarIds.length) await sequelize.query(`DELETE FROM industrial_records WHERE id IN (:ids)`, { replacements: { ids: probarIds } });
    if (adminId) await User.destroy({ where: { id: adminId } });
    await sequelize.close();
  });

  test("TEST 1 — PROMESH Machine 1, Matin : la fiche de production du matin est associée automatiquement", async () => {
    const res = await create({ productionType: "PROMESH", machine: "1", productionDate: DAY, poste: "matin" });
    expect(res.status).toBe(201);
    expect(res.body.data.productionMatch).toMatchObject({ matched: true, reason: null });
    expect((await dbRow(res.body.data.id)).productionRecordId).toBe(fiche.m1Matin);
    expect(res.body.data.ficheNumero).toMatch(/^PROMESH-\d{4}-\d{6}$/);
    await drop(res);
  });

  test("TEST 2 — même date, poste Soir : la fiche du soir, jamais celle du matin", async () => {
    const res = await create({ productionType: "PROMESH", machine: "1", productionDate: DAY, poste: "soir" });
    expect(res.status).toBe(201);
    const row = await dbRow(res.body.data.id);
    expect(row.productionRecordId).toBe(fiche.m1Soir);
    expect(row.productionRecordId).not.toBe(fiche.m1Matin);
    expect(row.poste).toBe("soir");
    await drop(res);
  });

  test("TEST 3 — PROMESH Machine 2 : la production de la machine 2, pas celle de la machine 1", async () => {
    const res = await create({ productionType: "PROMESH", machine: "2", productionDate: DAY, poste: "matin" });
    expect((await dbRow(res.body.data.id)).productionRecordId).toBe(fiche.m2Matin);
  });

  test("TEST 4 — PROBAR : seule la production PROBAR est recherchée (Machine 1 Matin, Machine 2 Soir)", async () => {
    const a = await create({ productionType: "PROBAR", machine: "1", productionDate: DAY, poste: "matin" });
    expect((await dbRow(a.body.data.id)).productionRecordId).toBe(fiche.probarM1Matin);
    expect(a.body.data.ficheNumero).toMatch(/^PROBAR-/);
    const b = await create({ productionType: "PROBAR", machine: "2", productionDate: DAY, poste: "soir" });
    expect((await dbRow(b.body.data.id)).productionRecordId).toBe(fiche.probarM2Soir);
    // PROBAR Machine 1 Soir : aucune fiche PROBAR — la fiche PROMESH M1 Soir n'est pas prise.
    const c = await create({ productionType: "PROBAR", machine: "1", productionDate: DAY, poste: "soir" });
    expect((await dbRow(c.body.data.id)).productionRecordId).toBeNull();
  });

  test("TEST 5 — aucune fiche de production : le contrôle est créé, productionRecordId NULL, validation possible", async () => {
    const res = await create({ productionType: "PROMESH", machine: "1", productionDate: EMPTY_DAY, poste: "matin" });
    expect(res.status).toBe(201);
    expect(res.body.data.productionMatch).toMatchObject({ matched: false, reason: "NO_PRODUCTION_SHEET" });
    expect((await dbRow(res.body.data.id)).productionRecordId).toBeNull();
    const v = await request(app)
      .post(`/quality-control/${res.body.data.id}/validate`)
      .set(auth(qc))
      .send({ status: "CONFORME", items: [{ parameterKey: "temperature_machine", value: "185", status: "CONFORME" }] });
    expect(v.status).toBe(200);
    expect(v.body.data.isValidated).toBe(true);
  });

  test("plusieurs fiches correspondantes : MULTIPLE_PRODUCTION_SHEETS, aucune association arbitraire", async () => {
    const res = await create({ productionType: "PROMESH", machine: "3", productionDate: DAY, poste: "matin" });
    expect(res.status).toBe(201);
    expect(res.body.data.productionMatch).toMatchObject({ matched: false, reason: "MULTIPLE_PRODUCTION_SHEETS" });
    expect((await dbRow(res.body.data.id)).productionRecordId).toBeNull();
  });

  test("fiche de production archivée : jamais associée", async () => {
    const res = await create({ productionType: "PROMESH", machine: "4", productionDate: DAY, poste: "matin" });
    expect(res.body.data.productionMatch).toMatchObject({ matched: false, reason: "NO_PRODUCTION_SHEET" });
  });

  test("un productionRecordId envoyé par le client est ignoré : le serveur recalcule", async () => {
    const res = await create({ productionType: "PROMESH", machine: "1", productionDate: EMPTY_DAY, poste: "matin", productionRecordId: fiche.m2Matin, productionId: fiche.m2Matin });
    expect(res.status).toBe(201);
    expect((await dbRow(res.body.data.id)).productionRecordId).toBeNull();
    const put = await request(app).put(`/quality-control/${res.body.data.id}`).set(auth(qc)).send({ productionRecordId: fiche.m2Matin, lot: "X" });
    expect(put.status).toBe(200);
    expect((await dbRow(res.body.data.id)).productionRecordId).toBeNull();
  });

  let draft;

  test("TEST 6/7 — lot et ordre de fabrication : enregistrés, relus à la réouverture ; vides par défaut", async () => {
    const res = await create({ productionType: "PROMESH", machine: "1" });
    draft = res.body.data.id;
    expect(res.body.data).toMatchObject({ lot: null, manufacturingOrder: null });

    const put = await request(app).put(`/quality-control/${draft}`).set(auth(qc)).send({ lot: "  LOT-12345 ", manufacturingOrder: "OF-2026-00458" });
    expect(put.status).toBe(200);
    // L'ordre de fabrication n'est jamais saisi : sans fiche de production, il reste non renseigné.
    expect(await dbRow(draft)).toMatchObject({ lot: "LOT-12345", manufacturingOrder: null });

    const reopened = await request(app).get(`/quality-control/${draft}`).set(auth(qc));
    expect(reopened.body.data).toMatchObject({ lot: "LOT-12345", manufacturingOrder: null });
    expect(reopened.body.data.history.some((h) => h.field === "lot" && h.newValue === "LOT-12345")).toBe(true);
  });

  test("TEST 8 — édition du brouillon : date, poste, lot, OF conservés ; association recalculée (Matin → Soir)", async () => {
    const a = await request(app).put(`/quality-control/${draft}`).set(auth(qc)).send({ productionDate: DAY, poste: "matin", lot: "LOT-2026-103", manufacturingOrder: "OF-2026-00459" });
    expect(a.status).toBe(200);
    // Fabrication identifiée par le serveur : numéro de la fiche de production + date.
    expect(await dbRow(draft)).toMatchObject({ productionRecordId: fiche.m1Matin, productionDate: DAY, poste: "matin", lot: "LOT-2026-103", manufacturingOrder: expect.stringMatching(/^PROMESH-\d{4}-\d{6} — 10\/05\/2032$/) });

    const b = await request(app).put(`/quality-control/${draft}`).set(auth(qc)).send({ poste: "soir" });
    expect(b.body.data.productionMatch).toMatchObject({ matched: true, reason: null });
    expect(await dbRow(draft)).toMatchObject({ productionRecordId: fiche.m1Soir, lot: "LOT-2026-103" });

    // Date sans production : l'ancienne association n'est pas conservée à tort.
    const c = await request(app).put(`/quality-control/${draft}`).set(auth(qc)).send({ productionDate: EMPTY_DAY });
    expect(c.body.data.productionMatch).toMatchObject({ matched: false, reason: "NO_PRODUCTION_SHEET" });
    expect((await dbRow(draft)).productionRecordId).toBeNull();

    // Lot vidé = champ vide (NULL), l'ordre de fabrication reste.
    await request(app).put(`/quality-control/${draft}`).set(auth(qc)).send({ lot: "", productionDate: DAY });
    expect(await dbRow(draft)).toMatchObject({ lot: null, manufacturingOrder: expect.stringMatching(/^PROMESH-\d{4}-\d{6} — 10\/05\/2032$/), productionRecordId: fiche.m1Soir });
  });

  test("TEST 9 — contrôle validé : date de production, poste, lot et ordre de fabrication en lecture seule (403)", async () => {
    const v = await request(app)
      .post(`/quality-control/${draft}/validate`)
      .set(auth(qc))
      .send({ status: "CONFORME", lot: "LOT-FINAL", items: [{ parameterKey: "temperature_machine", value: "185", status: "CONFORME" }] });
    expect(v.status).toBe(200);
    const before = await dbRow(draft);
    expect(before).toMatchObject({ lot: "LOT-FINAL", productionRecordId: fiche.m1Soir });

    for (const body of [{ lot: "AUTRE" }, { manufacturingOrder: "AUTRE" }, { poste: "matin" }, { productionDate: EMPTY_DAY }]) {
      const res = await request(app).put(`/quality-control/${draft}`).set(auth(qc)).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("CONTROL_LOCKED");
    }
    expect(await dbRow(draft)).toEqual(before);
  });

  test("GET /production-match : état de la recherche, sans identité de la production", async () => {
    const q = (p) => request(app).get(`/quality-control/production-match?${p}`).set(auth(qc));
    const found = await q(`productionType=PROMESH&machine=1&productionDate=${DAY}&poste=soir`);
    expect(found.status).toBe(200);
    expect(found.body.data).toMatchObject({ matched: true, reason: null });
    expect((await q(`productionType=PROMESH&machine=1&productionDate=${EMPTY_DAY}&poste=matin`)).body.data).toMatchObject({ matched: false, reason: "NO_PRODUCTION_SHEET" });
    expect((await q(`productionType=PROMESH&machine=3&productionDate=${DAY}&poste=matin`)).body.data).toMatchObject({ matched: false, reason: "MULTIPLE_PRODUCTION_SHEETS" });
    expect((await q(`productionType=PROMESH&machine=1&productionDate=${DAY}`)).status).toBe(400);
    expect((await q(`productionType=PROMESH&machine=1&productionDate=${DAY}&poste=nuit`)).status).toBe(400);
    expect((await q(`productionType=PROMESH&machine=9&productionDate=${DAY}&poste=matin`)).status).toBe(400);
    expect((await request(app).get(`/quality-control/production-match?productionType=PROMESH&machine=1&productionDate=${DAY}&poste=matin`)).status).toBe(401);
  });

  test("lot / ordre de fabrication : longueur maximale 100 (400) ; recherche de l'historique par lot", async () => {
    const res = await create({ productionType: "PROMESH", machine: "1", lot: "x".repeat(101) });
    expect(res.status).toBe(400);
    const tag = `LOT-RUN-${RUN_ID}`;
    const ok = await create({ productionType: "PROBAR", machine: "3", lot: tag, manufacturingOrder: `OF-${RUN_ID}` });
    expect(ok.status).toBe(201);
    const list = await request(app).get(`/quality-control?search=${tag}`).set(auth(qc));
    expect(list.body.data.map((c) => c.id)).toEqual([ok.body.data.id]);
    expect(list.body.data[0]).toMatchObject({ lot: tag, manufacturingOrder: null });
  });

  test("statistiques : basées sur les fiches qualité, inchangées par l'association", async () => {
    const before = (await request(app).get("/quality-control/stats").set(auth(qc))).body.data.totals.total;
    const [{ n }] = await sequelize.query(
      `SELECT count(*)::int n FROM quality_controls WHERE "deletedAt" IS NULL AND "controllerUserId" IN (SELECT id FROM users WHERE email = :e)`,
      { replacements: { e: QC_EMAIL }, type: QueryTypes.SELECT }
    );
    expect(before).toBe(n);
  });
});
