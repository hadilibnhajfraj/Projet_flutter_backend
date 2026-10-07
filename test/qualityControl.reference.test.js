"use strict";

// Module CONTRÔLE QUALITÉ — référence (étiquette) d'une fiche, générée par le
// serveur à la première sauvegarde : QC-PROMESH-NNNNNN / QC-PROBAR-NNNNNN.
// Compteur propre à chaque ligne, incrémental, jamais réutilisé après une
// suppression, sûr en création simultanée. Les fiches créées sont supprimées
// en afterAll (la numérotation réelle n'est donc pas consommée par ce test).

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
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });
const ref = (type, n) => `QC-${type}-${String(n).padStart(6, "0")}`;
const numberOf = (reference) => Number(reference.split("-")[2]);

// Dernier numéro attribué à une ligne (fiches supprimées comprises).
async function last(type) {
  const [{ n }] = await sql(`SELECT COALESCE(MAX(CAST(substring(reference FROM :start) AS int)), 0)::int n FROM quality_controls WHERE reference ~ :p`, {
    start: `QC-${type}-`.length + 1,
    p: `^QC-${type}-[0-9]+$`,
  });
  return n;
}

describe("Contrôle Qualité — référence QC-PROMESH / QC-PROBAR", () => {
  let qc;
  let promesh0;
  let probar0;
  const refs = {};

  async function create(type, machine = "1") {
    const res = await request(app).post("/quality-control").set(auth(qc)).send({ productionType: type, machine });
    if (res.body.data?.id) created.push(res.body.data.id);
    return res;
  }

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
    promesh0 = await last("PROMESH");
    probar0 = await last("PROBAR");
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

  test("TEST PROMESH — trois contrôles : numéros consécutifs, générés par le serveur à la création", async () => {
    const a = await create("PROMESH");
    const b = await create("PROMESH");
    const c = await create("PROMESH", "2");
    expect([a, b, c].map((r) => r.status)).toEqual([201, 201, 201]);
    expect([a, b, c].map((r) => r.body.data.reference)).toEqual([ref("PROMESH", promesh0 + 1), ref("PROMESH", promesh0 + 2), ref("PROMESH", promesh0 + 3)]);
    refs.p1 = a.body.data;
    refs.p2 = b.body.data;
    refs.p3 = c.body.data;
    expect(refs.p1.reference).toMatch(/^QC-PROMESH-\d{6}$/);
    // Enregistrée en PostgreSQL, relue par l'API.
    const [row] = await sql(`SELECT reference FROM quality_controls WHERE id = :id`, { id: refs.p1.id });
    expect(row.reference).toBe(refs.p1.reference);
    expect((await request(app).get(`/quality-control/${refs.p1.id}`).set(auth(qc))).body.data.reference).toBe(refs.p1.reference);
  });

  test("TEST PROBAR — compteur indépendant de PROMESH", async () => {
    const a = await create("PROBAR");
    const b = await create("PROBAR");
    expect([a, b].map((r) => r.body.data.reference)).toEqual([ref("PROBAR", probar0 + 1), ref("PROBAR", probar0 + 2)]);
    refs.b1 = a.body.data;
    // Les créations PROBAR n'ont pas avancé le compteur PROMESH, et inversement.
    expect(await last("PROMESH")).toBe(promesh0 + 3);
    expect(await last("PROBAR")).toBe(probar0 + 2);
  });

  test("TEST SUPPRESSION — un numéro supprimé n'est jamais réutilisé", async () => {
    const del = await request(app).delete(`/quality-control/${refs.p2.id}`).set(auth(qc));
    expect(del.status).toBe(200);
    const next = await create("PROMESH");
    expect(next.body.data.reference).toBe(ref("PROMESH", promesh0 + 4));
    expect(next.body.data.reference).not.toBe(refs.p2.reference);
    // La référence supprimée reste en base, hors des listes.
    const [row] = await sql(`SELECT "deletedAt" IS NOT NULL AS deleted FROM quality_controls WHERE reference = :r`, { r: refs.p2.reference });
    expect(row.deleted).toBe(true);
  });

  test("TEST CONCURRENCE — créations simultanées : aucune référence en double, aucune erreur, séquence complète", async () => {
    const results = await Promise.all([
      ...["1", "2", "3", "4", "1", "2"].map((m) => create("PROMESH", m)),
      ...["1", "2", "3", "4"].map((m) => create("PROBAR", m)),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    const promesh = results.slice(0, 6).map((r) => numberOf(r.body.data.reference)).sort((a, b) => a - b);
    const probar = results.slice(6).map((r) => numberOf(r.body.data.reference)).sort((a, b) => a - b);
    expect(promesh).toEqual([5, 6, 7, 8, 9, 10].map((i) => promesh0 + i));
    expect(probar).toEqual([3, 4, 5, 6].map((i) => probar0 + i));
    const [{ n, d }] = await sql(`SELECT count(*)::int n, count(DISTINCT reference)::int d FROM quality_controls WHERE id IN (:ids)`, { ids: created });
    expect(n).toBe(d);
  });

  test("référence non modifiable par l'utilisateur ; distincte de la référence de production", async () => {
    const put = await request(app).put(`/quality-control/${refs.p1.id}`).set(auth(qc)).send({ reference: "QC-PROMESH-999999", controlReference: "X", lot: "L1" });
    expect(put.status).toBe(200);
    expect(put.body.data.reference).toBe(refs.p1.reference);
    const forced = await request(app).post("/quality-control").set(auth(qc)).send({ productionType: "PROBAR", machine: "1", reference: "QC-PROBAR-999999" });
    created.push(forced.body.data.id);
    expect(forced.body.data.reference).toBe(ref("PROBAR", probar0 + 7));
    expect(forced.body.data.reference).not.toMatch(/^PROBAR-/); // jamais le format d'une fiche de production
  });

  test("recherche et historique par référence ; anciennes références conservées", async () => {
    const list = await request(app).get(`/quality-control?search=${refs.p3.reference}`).set(auth(qc));
    expect(list.body.data.map((c) => c.id)).toEqual([refs.p3.id]);
    expect(list.body.data[0]).toMatchObject({ reference: refs.p3.reference, machine: "2", productionType: "PROMESH" });
    // Les fiches créées avant la nouvelle numérotation gardent leur référence.
    const old = await sql(`SELECT id, reference FROM quality_controls WHERE reference ~ '^QC-[0-9]{4}-[0-9]{5}$' AND "deletedAt" IS NULL ORDER BY reference LIMIT 1`);
    if (old.length) {
      const found = await request(app).get(`/quality-control?search=${old[0].reference}`).set(auth(qc));
      expect(found.body.data.map((c) => c.reference)).toContain(old[0].reference);
    }
  });

  test("export : colonne « Référence contrôle », contrôleur affiché « Contrôle Qualité »", async () => {
    const res = await request(app)
      .get(`/quality-control/export?format=csv&search=${refs.b1.reference}`)
      .set(auth(qc))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (d) => chunks.push(d));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const csv = res.body.toString("utf8");
    const [header, row] = csv.replace(/^﻿/, "").trim().split(/\r?\n/);
    const cols = header.split(";");
    const cells = row.split(";");
    expect(cols).toEqual(expect.arrayContaining(["Référence contrôle", "Ligne", "Machine", "Date", "Poste", "Résultat", "Contrôleur qualité"]));
    expect(cells[cols.indexOf("Référence contrôle")]).toBe(refs.b1.reference);
    expect(cells[cols.indexOf("Ligne")]).toBe("PROBAR");
    expect(cells[cols.indexOf("Contrôleur qualité")]).toBe("Contrôle Qualité");
    expect(csv).not.toContain("controle_qualite@");
  });
});
