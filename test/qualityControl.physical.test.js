"use strict";

// Module CONTRÔLE QUALITÉ — PARAMÈTRES PHYSIQUES au niveau de la FICHE
// (indépendants du temps), séparés des contrôles temporels des prélèvements.
// Test obligatoire : PROBAR Machine 1, 28/08, Matin — production FAB01 / Ø12
// / LOT-01 ; trois prélèvements ; 11 paramètres physiques PROBAR enregistrés UNE
// fois. Les fiches de production et de contrôle créées (date lointaine) sont
// supprimées en afterAll.

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
const IndustrialRecord = require("../src/models/IndustrialRecord");
const cfg = require("../src/config/qualityControl");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const RUN_ID = Date.now();
const DAY = "2035-08-28";
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];
const probarIds = [];
let adminId;

const PROBAR_LABELS = [
  "DIAMÈTRE NOMINAL",
  "DIAMÈTRE RÉEL",
  "SECTION TRANSVERSALE",
  "LONGUEUR",
  "POIDS EN g",
  "DÉFAUTS SUPERFICIELS",
  "QUALITÉ DE COUPE",
];
const PROBAR_KEYS = cfg.physicalParameters("PROBAR").map((p) => p.key);

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

describe("Contrôle Qualité — paramètres physiques de la fiche (indépendants des prélèvements)", () => {
  let qc;
  let admin;
  let ficheId;
  const reading = {};

  const post = (path, body) => request(app).post(path).set(auth(qc)).send(body);
  const put = (path, body) => request(app).put(path).set(auth(qc)).send(body);
  const get = (path, token = qc) => request(app).get(path).set(auth(token));
  const physicalRows = (id) =>
    sql(`SELECT "parameterKey" k, value, "readingId" FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" IN (:keys) ORDER BY position`, {
      id,
      keys: cfg.parameters.filter((p) => p.scope === "fiche").map((p) => p.key),
    });

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
    const user = await User.create({ email: `qc-physical-admin-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash("StrongPass123!", 12), isActive: true, role: "superadmin" });
    adminId = user.id;
    admin = (await request(app).post("/auth/signin").send({ email: user.email, password: "StrongPass123!" })).body.accessToken;
    const prod = await IndustrialRecord.create({
      module: "probar",
      machine: "1",
      poste: "matin",
      dateFiche: DAY,
      createdBy: adminId,
      statut: "validee",
      lot: "LOT-01",
      ordreFabrication: "FAB01",
      description: JSON.stringify({ dia: "12" }),
    });
    probarIds.push(prod.id);
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
    if (probarIds.length) await sequelize.query(`DELETE FROM industrial_records WHERE id IN (:ids)`, { replacements: { ids: probarIds } });
    if (adminId) await User.destroy({ where: { id: adminId } });
    await sequelize.close();
  }, 30000);

  test("configuration : contrôles d'un prélèvement et paramètres physiques séparés ; PROBAR = les 7 paramètres du contrôle produit", async () => {
    const { data } = (await get("/quality-control/config")).body;
    const physical = data.parameters.filter((p) => p.scope === "fiche");
    expect(physical.filter((p) => p.lines.includes("PROBAR")).map((p) => p.label)).toEqual(PROBAR_LABELS);
    // PROMESH : contrôle produit (7 caractéristiques du produit, niveau fiche).
    expect(physical.filter((p) => p.lines.includes("PROMESH")).map((p) => p.key)).toEqual(expect.arrayContaining(["promesh_diametre_reel", "nombre_bar_longueur", "nombre_bar_largeur", "dimensions_maille", "dimensions_cote_1_long", "dimensions_cote_2_long", "etat_impression"]));
    expect(physical.filter((p) => p.lines.includes("PROMESH"))).toHaveLength(7);
    // Aucune unité inventée pour PROBAR ; aucun paramètre physique dans les contrôles d'un prélèvement.
    expect(physical.filter((p) => p.lines.includes("PROBAR")).every((p) => p.unit === null)).toBe(true);
    expect(data.parameters.filter((p) => p.scope === "reading").some((p) => p.section === "physique")).toBe(false);
  });

  test("TEST OBLIGATOIRE — PROBAR Machine 1, Matin : FAB01 — 28/08 — Ø12 et LOT-01 automatiques ; prélèvements 08:00 et 11:00 validés, 14:00 actif", async () => {
    const res = await post("/quality-control", {
      productionType: "PROBAR",
      machine: "1",
      productionDate: DAY,
      poste: "matin",
      reading: { readingTime: "08:00", items: [{ parameterKey: "nombre_bobines", value: "20", status: "CONFORME" }], validate: true },
    });
    expect(res.status).toBe(201);
    const c = res.body.data;
    ficheId = c.id;
    created.push(ficheId);
    reading.r1 = c.readingId;
    expect(c).toMatchObject({ manufacturingOrder: "FAB01 — 28/08/2035 — Ø12", manufacturingOrderAuto: true, lot: "LOT-01", lotAuto: true, isValidated: false });
    expect(c.readings[0]).toMatchObject({ step: 1, readingTime: "08:00", isValidated: true, status: "CONFORME" });
    // Paramètres physiques : ceux de PROBAR, vides, au niveau de la fiche.
    expect(c.physicalParameters.map((p) => p.parameterName)).toEqual(PROBAR_LABELS);
    expect(c.physicalParameters.every((p) => p.value === null)).toBe(true);

    const r2 = await post(`/quality-control/${ficheId}/readings`, { readingTime: "11:00", items: [{ parameterKey: "nombre_bobines", value: "22", status: "CONFORME" }], validate: true });
    reading.r2 = r2.body.data.readingId;
    const r3 = await post(`/quality-control/${ficheId}/readings`, { readingTime: "14:00", items: [{ parameterKey: "nombre_bobines", value: "24", status: "CONFORME" }] });
    reading.r3 = r3.body.data.readingId;
    expect(r3.body.data.readings.map((r) => [r.step, r.readingTime, r.isValidated])).toEqual([
      [1, "08:00", true],
      [2, "11:00", true],
      [3, "14:00", false],
    ]);
  });

  test("paramètres physiques PROBAR : enregistrés UNE fois sur la fiche, jamais dans un prélèvement", async () => {
    const values = Object.fromEntries(PROBAR_KEYS.map((k, i) => [k, `v${i + 1}`]));
    values.phys_diametre_nominal = "12";
    values.phys_diametre_reel = "12.1";
    values.phys_qualite_coupe = "BON"; // choix Bon / Pas bon, jamais une saisie libre
    values.phys_defauts_superficiels_controle = "OK"; // choix OK / NOK
    const res = await put(`/quality-control/${ficheId}`, { physical: PROBAR_KEYS.map((k) => ({ parameterKey: k, value: values[k] })) });
    expect(res.status).toBe(200);
    expect(res.body.data.physicalParameters.map((p) => [p.parameterKey, p.value])).toEqual(PROBAR_KEYS.map((k) => [k, values[k]]));

    // PostgreSQL : 7 lignes, une par paramètre, sans prélèvement (readingId NULL).
    const rows = await physicalRows(ficheId);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.readingId === null)).toBe(true);
    expect(rows.find((r) => r.k === "phys_diametre_reel").value).toBe("12.1");

    // Les prélèvements ne contiennent AUCUN paramètre physique, et restent indépendants.
    const detail = (await get(`/quality-control/${ficheId}`)).body.data;
    for (const r of detail.readings) {
      expect(r.items).toHaveLength(cfg.readingParametersFor("PROBAR").length);
      expect(r.items.some((i) => i.parameterKey.startsWith("phys_"))).toBe(false);
    }
    expect(detail.readings.map((r) => r.items.find((i) => i.parameterKey === "nombre_bobines").value)).toEqual(["20", "22", "24"]);
    // Hors des compteurs « paramètres contrôlés » des prélèvements.
    expect(detail.counts).toMatchObject({ controlled: 3, total: cfg.readingParametersFor("PROBAR").length * 3 });
  });

  test("un nouveau prélèvement ne duplique pas les paramètres physiques ; modification = même ligne, tracée", async () => {
    const r4 = await post(`/quality-control/${ficheId}/readings`, { readingTime: "17:00" });
    expect(r4.status).toBe(201);
    expect(await physicalRows(ficheId)).toHaveLength(7);
    expect(r4.body.data.physicalParameters.find((p) => p.parameterKey === "phys_diametre_reel").value).toBe("12.1");

    const upd = await put(`/quality-control/${ficheId}`, { physical: [{ parameterKey: "phys_longueur", value: "6000" }, { parameterKey: "phys_section_transversale", value: "" }] });
    expect(upd.status).toBe(200);
    const rows = await physicalRows(ficheId);
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.k === "phys_longueur").value).toBe("6000");
    expect(rows.find((r) => r.k === "phys_section_transversale").value).toBeNull(); // vidé
    expect(rows.find((r) => r.k === "phys_diametre_nominal").value).toBe("12"); // champ absent : intact
    const h = upd.body.data.history.find((x) => x.parameterKey === "phys_longueur" && x.newValue === "6000");
    expect(h).toMatchObject({ action: "UPDATE", parameterName: "LONGUEUR", readingTime: null });
    // Aucun prélèvement touché.
    expect(upd.body.data.readings.map((r) => r.items.find((i) => i.parameterKey === "nombre_bobines").value)).toEqual(["20", "22", "24", null]);
  });

  test("niveaux jamais mélangés : paramètre physique refusé dans un prélèvement, contrôle refusé en paramètre physique, autre ligne refusée", async () => {
    const inReading = await put(`/quality-control/${ficheId}/readings/${reading.r3}`, { items: [{ parameterKey: "phys_longueur", value: "1", status: "CONFORME" }] });
    expect(inReading.status).toBe(400);
    const inPhysical = await put(`/quality-control/${ficheId}`, { physical: [{ parameterKey: "nombre_bobines", value: "1" }] });
    expect(inPhysical.status).toBe(400);
    // Contrôle de prélèvement PROMESH envoyé comme paramètre physique d'une fiche PROBAR.
    const otherLine = await put(`/quality-control/${ficheId}`, { physical: [{ parameterKey: "dimensions_maille", value: "20 x 20" }] });
    expect(otherLine.status).toBe(400);
    expect(["UNKNOWN_PARAMETER", "INVALID_PAYLOAD"]).toContain(otherLine.body.code);
    expect(await physicalRows(ficheId)).toHaveLength(7);
    // Saisie réservée au contrôle qualité.
    expect((await request(app).put(`/quality-control/${ficheId}`).set(auth(admin)).send({ physical: [{ parameterKey: "phys_longueur", value: "1" }] })).status).toBe(403);
  });

  test("PROMESH : contrôle produit au niveau fiche, enregistré une fois ; jamais dans un prélèvement", async () => {
    const res = await post("/quality-control", {
      productionType: "PROMESH",
      machine: "2",
      productionDate: DAY,
      poste: "matin",
      reading: { readingTime: "08:00", items: [{ parameterKey: "temperature_machine", value: "20", status: "CONFORME" }] },
    });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    created.push(id);
    expect(res.body.data.physicalParameters.every((p) => p.value === null)).toBe(true);
    expect(res.body.data.readings[0].items.some((i) => ["dimensions_maille", "nombre_bar_longueur"].includes(i.parameterKey))).toBe(false);
    // Caractéristique du produit envoyée dans un prélèvement : refusée.
    expect((await put(`/quality-control/${id}/readings/${res.body.data.readingId}`, { items: [{ parameterKey: "dimensions_maille", value: "20 x 20", status: "CONFORME" }] })).status).toBe(400);
    // Au niveau de la fiche : enregistrée une fois (readingId NULL).
    const saved = await put(`/quality-control/${id}`, { physical: [{ parameterKey: "dimensions_maille", value: "20 x 20" }, { parameterKey: "nombre_bar_longueur", value: "15" }] });
    expect(saved.status).toBe(200);
    expect(await physicalRows(id)).toEqual(expect.arrayContaining([expect.objectContaining({ k: "dimensions_maille", value: "20 x 20", readingId: null }), expect.objectContaining({ k: "nombre_bar_longueur", value: "15", readingId: null })]));
    expect(await physicalRows(id)).toHaveLength(2);
    // Paramètre physique PROBAR : refusé pour PROMESH.
    expect((await put(`/quality-control/${id}`, { physical: [{ parameterKey: "phys_longueur", value: "1" }] })).status).toBe(400);
  });

  test("fiche validée : paramètres physiques en lecture seule (403), prélèvements conservés", async () => {
    await request(app).delete(`/quality-control/${ficheId}/readings/${(await get(`/quality-control/${ficheId}`)).body.data.readings[3].id}`).set(auth(qc));
    const v = await post(`/quality-control/${ficheId}/validate`, { status: "CONFORME" });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ isValidated: true, status: "CONFORME", readingsCount: 3 });
    const locked = await put(`/quality-control/${ficheId}`, { physical: [{ parameterKey: "phys_longueur", value: "1" }] });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("CONTROL_LOCKED");
    const detail = (await get(`/quality-control/${ficheId}`, admin)).body.data;
    expect(detail.physicalParameters.find((p) => p.parameterKey === "phys_longueur").value).toBe("6000");
    expect(detail.readings.map((r) => r.readingTime)).toEqual(["08:00", "11:00", "14:00"]);
  });
});
