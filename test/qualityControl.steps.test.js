"use strict";

// Module CONTRÔLE QUALITÉ — étapes (prélèvements numérotés) et lot / ordre de
// fabrication repris AUTOMATIQUEMENT de la fiche de production (ligne +
// machine + date de production + poste). Les fiches de production utilisées
// sont créées par ce test à une date lointaine puis supprimées, comme les
// fiches qualité.

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
const DAY = "2034-10-03";
const EMPTY_DAY = "2034-10-04";
const FAB_DAY = "2034-08-28";
const FAB = "FAB01 — 03/10/2034 — Ø12";
const SOIR_FAB = expect.stringMatching(/^PROMESH-\d{4}-\d{6} — 03\/10\/2034$/);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];
const promeshIds = [];
const probarIds = [];
let adminId;

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

async function dbFiche(id) {
  const [row] = await sql(`SELECT lot, "manufacturingOrder", "lotAuto", "manufacturingOrderAuto", "productionRecordId" FROM quality_controls WHERE id = :id`, { id });
  return row;
}

const valuesOf = (reading, keys) => keys.map((k) => reading.items.find((i) => i.parameterKey === k).value);
const KEYS = ["temperature_machine", "temperature_eau", "pression_air_comprime"];
const items = (values) => KEYS.map((k, i) => ({ parameterKey: k, value: values[i], status: "CONFORME" }));

describe("Contrôle Qualité — étapes et lot / ordre de fabrication automatiques", () => {
  let qc;
  let ficheId;
  const prod = {};
  const step = {};

  const post = (path, body) => request(app).post(path).set(auth(qc)).send(body);
  const put = (path, body) => request(app).put(path).set(auth(qc)).send(body);
  const get = (path) => request(app).get(path).set(auth(qc));

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
    const admin = await User.create({ email: `qc-steps-admin-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash("StrongPass123!", 12), isActive: true, role: "superadmin" });
    adminId = admin.id;
    const promesh = async (poste, extra) => {
      const f = await PorPromesh.create({ machine: "1", poste, dateProduction: DAY, createdBy: adminId, status: "VALIDE", ...extra });
      promeshIds.push(f.id);
      return f.id;
    };
    // Matin : la production porte le lot et l'ordre de fabrication.
    prod.matin = await promesh("matin", { lot: "LOT-2026-001", ordreFabrication: "FAB01", diametreMaille2: "12" });
    // Soir (« nuit » côté production) : fiche sans lot ni ordre de fabrication.
    prod.soir = await promesh("nuit", {});
    // Scénario demandé : PROBAR Machine 1, 28/08, Matin — FAB01, Ø12, LOT-1.
    const probar = await IndustrialRecord.create({ module: "probar", machine: "1", poste: "matin", dateFiche: FAB_DAY, createdBy: adminId, statut: "validee", lot: "LOT-1", ordreFabrication: "FAB01", description: JSON.stringify({ dia: "12", p: { r1: "x" } }) });
    // Fiche PROBAR sans ordre de fabrication ni diamètre : référence = numéro de la fiche.
    const bare = await IndustrialRecord.create({ module: "probar", machine: "2", poste: "matin", dateFiche: FAB_DAY, createdBy: adminId, statut: "validee", description: "{}" });
    probarIds.push(bare.id);
    probarIds.push(probar.id);
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
    if (promeshIds.length) await sequelize.query(`DELETE FROM por_promesh WHERE id IN (:ids)`, { replacements: { ids: promeshIds } });
    if (probarIds.length) await sequelize.query(`DELETE FROM industrial_records WHERE id IN (:ids)`, { replacements: { ids: probarIds } });
    if (adminId) await User.destroy({ where: { id: adminId } });
    await sequelize.close();
  }, 30000);

  test("recherche date + poste : lot et ordre de fabrication de la production, jamais son identité", async () => {
    const found = await get(`/quality-control/production-match?productionType=PROMESH&machine=1&productionDate=${DAY}&poste=matin`);
    expect(found.body.data).toEqual({ matched: true, reason: null, lot: "LOT-2026-001", manufacturingOrder: FAB });
    // Soir ≠ Matin : autre fiche de production, sans lot.
    const soir = await get(`/quality-control/production-match?productionType=PROMESH&machine=1&productionDate=${DAY}&poste=soir`);
    // Sans ordre de fabrication ni diamètre : numéro de la fiche de production + date.
    expect(soir.body.data).toEqual({ matched: true, reason: null, lot: null, manufacturingOrder: SOIR_FAB });
    const none = await get(`/quality-control/production-match?productionType=PROMESH&machine=1&productionDate=${EMPTY_DAY}&poste=matin`);
    expect(none.body.data).toEqual({ matched: false, reason: "NO_PRODUCTION_SHEET", lot: null, manufacturingOrder: null });
  });

  test("TEST COMPLET — fiche créée : lot et OF repris automatiquement (saisie client ignorée), ÉTAPE 1 à 08:00", async () => {
    const res = await post("/quality-control", {
      productionType: "PROMESH",
      machine: "1",
      productionDate: DAY,
      poste: "matin",
      lot: "SAISIE-MANUELLE",
      manufacturingOrder: "OF-MANUEL",
      reading: { readingTime: "08:00", items: items(["20", "180", "12"]) },
    });
    expect(res.status).toBe(201);
    const c = res.body.data;
    ficheId = c.id;
    created.push(ficheId);
    step.s1 = c.readingId;
    expect(c).toMatchObject({ lot: "LOT-2026-001", manufacturingOrder: FAB, lotAuto: true, manufacturingOrderAuto: true });
    expect(await dbFiche(ficheId)).toEqual({ lot: "LOT-2026-001", manufacturingOrder: FAB, lotAuto: true, manufacturingOrderAuto: true, productionRecordId: prod.matin });
    expect(c.readings).toHaveLength(1);
    expect(c.readings[0]).toMatchObject({ step: 1, sequence: 1, readingTime: "08:00" });
    expect(c.suggestedNextReadingTime).toBe("11:00");

    // Lecture seule : une saisie manuelle ne remplace jamais la valeur de la production.
    const manual = await put(`/quality-control/${ficheId}`, { lot: "AUTRE", manufacturingOrder: "" });
    expect(manual.status).toBe(200);
    expect(manual.body.data).toMatchObject({ lot: "LOT-2026-001", manufacturingOrder: FAB, lotAuto: true });
  });

  test("+ Nouveau prélèvement (11:00 proposé) : ÉTAPE 2 avec les MÊMES paramètres, valeurs vides et indépendantes", async () => {
    const res = await post(`/quality-control/${ficheId}/readings`, { readingTime: "11:00" });
    expect(res.status).toBe(201);
    step.s2 = res.body.data.readingId;
    const [r1, r2] = res.body.data.readings;
    expect(r2).toMatchObject({ id: step.s2, step: 2, sequence: 2, readingTime: "11:00", isValidated: false });
    // Même STRUCTURE de paramètres, aucune valeur recopiée.
    expect(r2.items.map((i) => i.parameterKey)).toEqual(r1.items.map((i) => i.parameterKey));
    expect(r2.items.every((i) => i.value === null && i.status === "NON_CONTROLE" && i.remark === null)).toBe(true);
    expect(valuesOf(r1, KEYS)).toEqual(["20", "180", "12"]);

    const filled = await put(`/quality-control/${ficheId}/readings/${step.s2}`, { items: items(["22", "182", "12.1"]) });
    expect(filled.status).toBe(200);
    const again = (await get(`/quality-control/${ficheId}`)).body.data;
    expect(valuesOf(again.readings[0], KEYS)).toEqual(["20", "180", "12"]); // ÉTAPE 1 intacte
    expect(valuesOf(again.readings[1], KEYS)).toEqual(["22", "182", "12.1"]);
  });

  test("TEST 3ᵉ PRÉLÈVEMENT — 14:00 proposé → 14:17 ; heure de l'étape 2 corrigée (11:05) sans changer l'ordre", async () => {
    expect((await get(`/quality-control/${ficheId}`)).body.data.suggestedNextReadingTime).toBe("14:00");
    const res = await post(`/quality-control/${ficheId}/readings`, { readingTime: "14:17", items: items(["21", "181", "12.2"]) });
    expect(res.status).toBe(201);
    step.s3 = res.body.data.readingId;
    const moved = await put(`/quality-control/${ficheId}/readings/${step.s2}`, { readingTime: "11:05" });
    expect(moved.body.data.readings.map((r) => [r.step, r.sequence, r.readingTime])).toEqual([
      [1, 1, "08:00"],
      [2, 2, "11:05"],
      [3, 3, "14:17"],
    ]);
    expect(moved.body.data.readings.map((r) => valuesOf(r, KEYS))).toEqual([
      ["20", "180", "12"],
      ["22", "182", "12.1"],
      ["21", "181", "12.2"],
    ]);
    const [{ n }] = await sql(`SELECT count(*)::int n FROM quality_controls WHERE "productionType" = 'PROMESH' AND machine = '1' AND "productionDate" = :d AND poste = 'matin' AND "deletedAt" IS NULL`, { d: DAY });
    expect(n).toBe(1); // UNE fiche, trois étapes
  });

  test("le rang d'une étape ne dépend jamais de l'heure : prélèvement saisi après coup, suppression, renumérotation", async () => {
    // Heure antérieure saisie en dernier : ÉTAPE 4 (dernier rang + 1), pas « étape 0 ».
    const late = await post(`/quality-control/${ficheId}/readings`, { readingTime: "07:30" });
    expect(late.body.data.readings.map((r) => [r.step, r.readingTime])).toEqual([[1, "08:00"], [2, "11:05"], [3, "14:17"], [4, "07:30"]]);
    expect(late.body.data.suggestedNextReadingTime).toBe("10:30"); // dernier prélèvement + 3 h
    // Suppression de l'étape 3 (brouillon) : les étapes affichées se renumérotent, les rangs stockés restent uniques.
    const del = await request(app).delete(`/quality-control/${ficheId}/readings/${step.s3}`).set(auth(qc));
    expect(del.body.data.readings.map((r) => [r.step, r.sequence, r.readingTime])).toEqual([[1, 1, "08:00"], [2, 2, "11:05"], [3, 4, "07:30"]]);
    const next = await post(`/quality-control/${ficheId}/readings`, { readingTime: "17:00" });
    expect(next.body.data.readings.map((r) => r.sequence)).toEqual([1, 2, 4, 5]);
    const rows = await sql(`SELECT sequence FROM quality_control_readings WHERE "qualityControlId" = :id ORDER BY sequence`, { id: ficheId });
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 4, 5]);
  });

  test("poste modifié (Soir, production sans lot) : valeur automatique effacée, saisie manuelle possible ; retour au Matin : automatique", async () => {
    const soir = await put(`/quality-control/${ficheId}`, { poste: "soir" });
    expect(soir.status).toBe(200);
    expect(soir.body.data).toMatchObject({ lot: null, manufacturingOrder: SOIR_FAB, lotAuto: false, manufacturingOrderAuto: true, productionMatch: { matched: true, reason: null } });
    expect((await dbFiche(ficheId)).productionRecordId).toBe(prod.soir);

    const manual = await put(`/quality-control/${ficheId}`, { lot: " LOT-SAISI ", manufacturingOrder: "OF-SAISI" });
    // Lot saisi (la production ne le porte pas) ; l'ordre de fabrication n'est JAMAIS saisi.
    expect(manual.body.data).toMatchObject({ lot: "LOT-SAISI", manufacturingOrder: SOIR_FAB, lotAuto: false, manufacturingOrderAuto: true });

    // La production du soir est complétée : le lot devient automatique à la sauvegarde suivante.
    await sequelize.query(`UPDATE por_promesh SET lot = 'LOT-SOIR-9' WHERE id = :id`, { replacements: { id: prod.soir } });
    const refreshed = await put(`/quality-control/${ficheId}`, {});
    expect(refreshed.body.data).toMatchObject({ lot: "LOT-SOIR-9", lotAuto: true, manufacturingOrder: SOIR_FAB });

    const matin = await put(`/quality-control/${ficheId}`, { poste: "matin" });
    expect(matin.body.data).toMatchObject({ lot: "LOT-2026-001", manufacturingOrder: FAB, lotAuto: true, manufacturingOrderAuto: true });
    expect(matin.body.data.history.some((h) => h.field === "lot" && h.newValue === "LOT-2026-001" && /automatiquement/.test(h.reason || ""))).toBe(true);
    // Les prélèvements n'ont pas bougé.
    expect(valuesOf(matin.body.data.readings[0], KEYS)).toEqual(["20", "180", "12"]);
  });

  test("aucune fiche de production : contrôle enregistré, lot et OF vides (saisie manuelle possible)", async () => {
    const res = await post("/quality-control", { productionType: "PROMESH", machine: "1", productionDate: EMPTY_DAY, poste: "matin" });
    expect(res.status).toBe(201);
    created.push(res.body.data.id);
    expect(res.body.data).toMatchObject({ lot: null, manufacturingOrder: null, lotAuto: false, manufacturingOrderAuto: false, productionMatch: { matched: false, reason: "NO_PRODUCTION_SHEET" } });
    const manual = await put(`/quality-control/${res.body.data.id}`, { lot: "LOT-LIBRE", manufacturingOrder: "OF-SAISI" });
    expect(manual.body.data).toMatchObject({ lot: "LOT-LIBRE", lotAuto: false, manufacturingOrder: null, manufacturingOrderAuto: false });
  });

  test("PROBAR Machine 1, 28/08, Matin : « FAB01 — 28/08/2034 — Ø12 » et LOT-1 repris de la production", async () => {
    const res = await post("/quality-control", { productionType: "PROBAR", machine: "1", productionDate: FAB_DAY, poste: "matin", manufacturingOrder: "OF-CONTROLEUR" });
    expect(res.status).toBe(201);
    created.push(res.body.data.id);
    // Identification de la fabrication : référence, date et diamètre de la fiche de production.
    expect(res.body.data).toMatchObject({ lot: "LOT-1", lotAuto: true, manufacturingOrder: "FAB01 — 28/08/2034 — Ø12", manufacturingOrderAuto: true });
    // Autre machine : sa propre fiche (sans ordre de fabrication ni diamètre → numéro de la fiche).
    const other = await post("/quality-control", { productionType: "PROBAR", machine: "2", productionDate: FAB_DAY, poste: "matin" });
    created.push(other.body.data.id);
    expect(other.body.data).toMatchObject({ lot: null, lotAuto: false, manufacturingOrderAuto: true });
    expect(other.body.data.manufacturingOrder).toMatch(/^PROBAR-\d{4}-[0-9A-F]{6} — 28\/08\/2034$/);
  });
});
