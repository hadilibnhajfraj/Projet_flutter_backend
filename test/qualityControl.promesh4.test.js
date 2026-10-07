"use strict";

// Module CONTRÔLE QUALITÉ — PROMESH 4 : paramètres propres à CETTE machine.
//
// Une fiche PROMESH Machine 4 porte :
//   - CONTRÔLE MACHINE (chaque prélèvement, 9 contrôles) : température
//     machine 1 (zone 1, zone 2), température machine 2 (zone 1, zone 2),
//     température d'eau, nombre de bobines, vitesse de tirage, viscosité de
//     la résine (bain 1, bain 2) ;
//   - CONTRÔLE PRODUIT (niveau fiche, 6 paramètres) : diamètre réel,
//     dimensions côté 1 longueur, nombre de barres en longueur, dimensions de
//     maille, nombre de barres en largeur, dimensions côté 2 longueur
//     (sans état d'impression, propre à PROMESH 1 à 3).
// PROMESH 1 / 2 / 3 et PROBAR gardent leurs listes.
//
// Fiches créées à une date lointaine (2036), supprimées en afterAll.

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
const cfg = require("../src/config/qualityControl");
const QualityControlItem = require("../src/models/QualityControlItem");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const DAY = "2036-04-14";
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];

const P4 = [
  ["promesh4_temperature_machine_1_zone_1", "TEMPÉRATURE MACHINE 1 — ZONE 1"],
  ["promesh4_temperature_machine_1_zone_2", "TEMPÉRATURE MACHINE 1 — ZONE 2"],
  ["promesh4_temperature_machine_2_zone_1", "TEMPÉRATURE MACHINE 2 — ZONE 1"],
  ["promesh4_temperature_machine_2_zone_2", "TEMPÉRATURE MACHINE 2 — ZONE 2"],
  ["temperature_eau", "TEMPÉRATURE D'EAU"],
  ["promesh4_nombre_bobines", "NOMBRE DE BOBINES"],
  ["promesh4_vitesse_tirage", "VITESSE DE TIRAGE"],
  ["promesh4_viscosite_bain_1", "VISCOSITÉ DE LA RÉSINE — BAIN 1"],
  ["promesh4_viscosite_bain_2", "VISCOSITÉ DE LA RÉSINE — BAIN 2"],
];
const KEYS = P4.map(([key]) => key);
const LABELS = P4.map(([, label]) => label);
// Contrôle produit PROMESH 4 (niveau fiche), dans l'ordre demandé.
const P4_PRODUCT = [
  ["promesh_diametre_reel", "DIAMÈTRE RÉEL"],
  ["dimensions_cote_1_long", "DIMENSIONS CÔTÉ 1 LONGUEUR"],
  ["nombre_bar_longueur", "NOMBRE DE BARRES EN LONGUEUR"],
  ["dimensions_maille", "DIMENSIONS DE MAILLE"],
  ["nombre_bar_largeur", "NOMBRE DE BARRES EN LARGEUR"],
  ["dimensions_cote_2_long", "DIMENSIONS CÔTÉ 2 LONGUEUR"],
];
const P4_PRODUCT_KEYS = P4_PRODUCT.map(([key]) => key);
const P4_PRODUCT_LABELS = P4_PRODUCT.map(([, label]) => label);
// Paramètres de la ligne PROMESH (machines 1 à 3) qui ne s'appliquent pas à la machine 4.
const LINE_ONLY = ["temperature_machine", "pression_air_comprime", "fuite_eau", "fuite_air_comprime", "etat_disque_coupe", "niveau_bain_graines", "promesh4_temperature_machine_1", "promesh4_temperature_machine_2"];
// Contrôle produit de la ligne PROMESH (machines 1 à 3).
const PRODUCT = ["promesh_diametre_reel", "nombre_bar_longueur", "nombre_bar_largeur", "dimensions_maille", "dimensions_cote_1_long", "dimensions_cote_2_long", "etat_impression"];

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

describe("Contrôle Qualité PROMESH 4 — paramètres propres à la machine", () => {
  let qc;
  let fiche;

  const post = (path, body) => request(app).post(path).set(auth(qc)).send(body);
  const put = (path, body) => request(app).put(path).set(auth(qc)).send(body);
  const get = (path) => request(app).get(path).set(auth(qc));
  const valuesOf = (reading) => Object.fromEntries(reading.items.filter((i) => i.value != null).map((i) => [i.parameterKey, i.value]));

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
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

  test("configuration : PROMESH 4 a ses propres listes (9 contrôles machine, 6 caractéristiques produit) ; machines 1 à 3 et PROBAR inchangés", async () => {
    expect(cfg.lineKey("PROMESH", "4")).toBe("PROMESH:4");
    for (const machine of ["1", "2", "3"]) expect(cfg.lineKey("PROMESH", machine)).toBe("PROMESH");
    for (const machine of ["1", "2", "3", "4"]) expect(cfg.lineKey("PROBAR", machine)).toBe("PROBAR");

    const p4 = cfg.readingParametersFor("PROMESH:4");
    expect(p4.map((p) => p.key)).toEqual(KEYS);
    expect(p4.map((p) => p.label)).toEqual(LABELS);
    expect(new Set(p4.map((p) => p.section))).toEqual(new Set(["controle_promesh_4"]));
    // Contrôle produit : niveau fiche, libellés et ordre propres à PROMESH 4.
    expect(cfg.physicalParameters("PROMESH:4").map((p) => p.key)).toEqual(P4_PRODUCT_KEYS);
    expect(cfg.physicalParameters("PROMESH:4").map((p) => p.label)).toEqual(P4_PRODUCT_LABELS);
    expect(cfg.specificParameters("PROMESH:4")).toEqual([]);
    expect(cfg.ficheParameters("PROMESH:4")).toHaveLength(6);
    for (const key of ["etat_impression", "vitesse_impression"]) expect(cfg.ficheParameters("PROMESH:4").map((p) => p.key)).not.toContain(key);

    // La ligne PROMESH (machines 1 à 3) et PROBAR ne reçoivent aucun paramètre propre à PROMESH 4
    // (le diamètre réel, clé « promesh_diametre_reel », est commun aux quatre machines PROMESH).
    for (const line of ["PROMESH", "PROBAR"]) {
      const keys = [...cfg.readingParametersFor(line), ...cfg.ficheParameters(line)].map((p) => p.key);
      expect(keys.filter((k) => k.startsWith("promesh4_"))).toEqual([]);
    }
    expect(cfg.readingParametersFor("PROMESH").map((p) => p.key)).toEqual(["temperature_machine", "temperature_eau", "pression_air_comprime", "fuite_eau", "fuite_air_comprime", "etat_disque_coupe", "niveau_bain_graines", "vitesse_impression"]);
    expect(cfg.physicalParameters("PROMESH").map((p) => p.key)).toEqual(PRODUCT);
    expect(cfg.physicalParameters("PROMESH").map((p) => p.label)).toEqual(["DIAMÈTRE RÉEL", "NOMBRE DE BARRES EN LONGUEUR", "NOMBRE DE BARRES EN LARGEUR", "DIMENSIONS DE MAILLE", "DIMENSIONS CÔTÉ 1 LONG", "DIMENSIONS CÔTÉ 2 LONG", "ÉTAT D'IMPRESSION"]);
    expect(cfg.readingParametersFor("PROBAR")).toHaveLength(15);
    expect(cfg.physicalParameters("PROBAR")).toHaveLength(7);

    // API.
    const { data } = (await get("/quality-control/config")).body;
    expect(data.machineLines).toEqual([{ type: "PROMESH", machine: "4", key: "PROMESH:4" }]);
    expect(data.sections.find((s) => s.key === "controle_promesh_4")).toMatchObject({ label: "Contrôle Machine" });
    const by = Object.fromEntries(data.parameters.map((p) => [p.key, p]));
    // Températures machine : deux zones par machine, en °C, sous un sous-titre commun.
    for (const m of [1, 2]) {
      for (const z of [1, 2]) {
        expect(by[`promesh4_temperature_machine_${m}_zone_${z}`]).toMatchObject({ kind: "number", unit: "°C", scope: "reading", lines: ["PROMESH:4"], group: `TEMPÉRATURE MACHINE ${m}`, shortLabel: `ZONE ${z}` });
      }
    }
    // L'ancienne température unique par machine n'est plus renvoyée.
    expect(by.promesh4_temperature_machine_1).toBeUndefined();
    expect(by.promesh4_temperature_machine_2).toBeUndefined();
    expect(by.promesh4_nombre_bobines).toMatchObject({ kind: "number", unit: null, group: null });
    expect(by.promesh4_vitesse_tirage).toMatchObject({ kind: "number", unit: null }); // aucune unité inventée
    // Viscosité de la résine : deux bains, en degrés (°).
    expect(by.promesh4_viscosite_bain_1).toMatchObject({ group: "VISCOSITÉ DE LA RÉSINE", shortLabel: "BAIN 1", unit: "°" });
    expect(by.promesh4_viscosite_bain_2).toMatchObject({ group: "VISCOSITÉ DE LA RÉSINE", shortLabel: "BAIN 2", unit: "°" });
    expect(by.temperature_eau).toMatchObject({ unit: "°C" });
    expect(by.temperature_eau.byLine["PROMESH:4"]).toEqual({ section: "controle_promesh_4", order: 5, label: "TEMPÉRATURE D'EAU" });
    // Contrôle produit.
    expect(by.promesh_diametre_reel).toMatchObject({ kind: "text", scope: "fiche", section: "physique", lines: ["PROMESH", "PROMESH:4"], unit: null });
    expect(by.promesh_diametre_reel.byLine["PROMESH:4"]).toEqual({ section: "physique", order: 1, label: "DIAMÈTRE RÉEL" });
    expect(by.dimensions_cote_1_long.byLine["PROMESH:4"]).toEqual({ section: "physique", order: 2, label: "DIMENSIONS CÔTÉ 1 LONGUEUR" });
    expect(by.dimensions_maille).toMatchObject({ hint: "ex. 20 × 20 mm" });
    // État d'impression : PROMESH 1 à 3 uniquement.
    expect(by.etat_impression.lines).toEqual(["PROMESH"]);
    expect(by.etat_impression.byLine["PROMESH:4"]).toBeUndefined();
  });

  test("nouvelle fiche PROMESH 4 : champs vides ; contrôle machine saisi, sauvegardé, relu depuis la base", async () => {
    const res = await post("/quality-control", { productionType: "PROMESH", machine: "4", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [] } });
    expect(res.status).toBe(201);
    fiche = res.body.data;
    created.push(fiche.id);
    const items = fiche.readings[0].items;
    expect(items.map((i) => i.parameterKey)).toEqual(KEYS);
    expect(items.map((i) => i.parameterName)).toEqual(LABELS);
    expect(items.every((i) => i.value === null && i.status === "NON_CONTROLE")).toBe(true);
    expect(fiche.readings[0].counts).toMatchObject({ total: 9, controlled: 0 });
    expect(fiche.physicalParameters.map((p) => p.parameterKey)).toEqual(P4_PRODUCT_KEYS);
    expect(fiche.physicalParameters.map((p) => p.parameterName)).toEqual(P4_PRODUCT_LABELS);
    expect(fiche.physicalParameters.every((p) => p.value === null)).toBe(true);
    expect(fiche.specificParameters).toEqual([]);

    const input = {
      promesh4_temperature_machine_1_zone_1: "182",
      promesh4_temperature_machine_1_zone_2: "186",
      promesh4_temperature_machine_2_zone_1: "> 190",
      promesh4_temperature_machine_2_zone_2: "194",
      temperature_eau: "18",
      promesh4_nombre_bobines: "24",
      promesh4_vitesse_tirage: "3,5 m/min",
      promesh4_viscosite_bain_1: "45",
      promesh4_viscosite_bain_2: "47",
    };
    const saved = await put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`, {
      items: KEYS.map((k) => ({ parameterKey: k, value: input[k], status: k === "promesh4_viscosite_bain_2" ? "NON_CONFORME" : "CONFORME", ...(k === "promesh4_viscosite_bain_2" ? { remark: "trop visqueux" } : {}) })),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.readings[0].counts).toMatchObject({ total: 9, controlled: 9, nonConformes: 1 });

    // PostgreSQL : une ligne par champ — chaque zone et chaque bain séparément.
    const rows = await sql(`SELECT "parameterKey" k, value FROM quality_control_items WHERE "qualityControlId" = :id AND "readingId" IS NOT NULL ORDER BY position`, { id: fiche.id });
    expect(Object.fromEntries(rows.map((r) => [r.k, r.value]))).toEqual(input);
    expect(rows).toHaveLength(9);

    // Réouverture : valeurs relues depuis la base.
    const reopened = (await get(`/quality-control/${fiche.id}`)).body.data;
    expect(valuesOf(reopened.readings[0])).toEqual(input);
    expect(reopened.readings[0].items.find((i) => i.parameterKey === "promesh4_viscosite_bain_2")).toMatchObject({ value: "47", status: "NON_CONFORME", remark: "trop visqueux" });
    expect(reopened.nonConformParameters).toEqual(["VISCOSITÉ DE LA RÉSINE — BAIN 2"]);

    // Modification d'UNE zone / d'UN bain sans toucher aux autres.
    await put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`, {
      items: [
        { parameterKey: "promesh4_temperature_machine_1_zone_2", value: "188", status: "CONFORME" },
        { parameterKey: "promesh4_viscosite_bain_2", value: "46", status: "CONFORME", remark: "" },
      ],
    });
    const after = valuesOf((await get(`/quality-control/${fiche.id}`)).body.data.readings[0]);
    expect(after).toEqual({ ...input, promesh4_temperature_machine_1_zone_2: "188", promesh4_viscosite_bain_2: "46" });
  });

  test("contrôle produit PROMESH 4 : 6 paramètres de niveau fiche, enregistrés une fois ; état d'impression absent et refusé", async () => {
    const ficheRows = () => sql(`SELECT "parameterKey" k, value FROM quality_control_items WHERE "qualityControlId" = :id AND "readingId" IS NULL`, { id: fiche.id });
    const filled = (c) => `${c.physicalParameters.filter((p) => p.value != null && String(p.value).trim() !== "").length} / ${c.physicalParameters.length}`;
    expect(filled(fiche)).toBe("0 / 6");
    const input = { promesh_diametre_reel: "Ø 6,1", dimensions_cote_1_long: "2400", nombre_bar_longueur: "15", dimensions_maille: "20 × 20 mm", nombre_bar_largeur: "9", dimensions_cote_2_long: "1200" };
    const saved = await put(`/quality-control/${fiche.id}`, { physical: P4_PRODUCT_KEYS.map((k) => ({ parameterKey: k, value: input[k] })) });
    expect(saved.status).toBe(200);
    expect(saved.body.data.physicalParameters.map((p) => [p.parameterKey, p.value])).toEqual(P4_PRODUCT_KEYS.map((k) => [k, input[k]]));
    expect(filled(saved.body.data)).toBe("6 / 6");
    expect(Object.fromEntries((await ficheRows()).map((r) => [r.k, r.value]))).toEqual(input);

    // Hors liste PROMESH 4 : état d'impression et vitesse d'impression (PROMESH 1 à 3), diamètre réel PROBAR.
    for (const parameterKey of ["etat_impression", "vitesse_impression", "phys_diametre_reel"]) {
      const refused = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey, value: "Conforme" }] });
      expect(refused.status).toBe(400);
    }
    // Jamais dans un prélèvement.
    for (const parameterKey of [...P4_PRODUCT_KEYS, "etat_impression", "vitesse_impression"]) {
      expect((await put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`, { items: [{ parameterKey, value: "Conforme", status: "CONFORME" }] })).status).toBe(400);
    }
    // Rechargement depuis la base.
    const reopened = (await get(`/quality-control/${fiche.id}`)).body.data;
    expect(Object.fromEntries(reopened.physicalParameters.map((p) => [p.parameterKey, p.value]))).toEqual(input);
    expect(reopened.physicalParameters.map((p) => p.parameterName)).not.toContain("ÉTAT D'IMPRESSION");
    expect(await ficheRows()).toHaveLength(6);
  });

  test("ancienne fiche PROMESH 4 : état d'impression déjà enregistré conservé en base, plus affiché ni repris", async () => {
    const res = await post("/quality-control", { productionType: "PROMESH", machine: "4", productionDate: DAY, poste: "soir", reading: { readingTime: "08:00", items: [{ parameterKey: "temperature_eau", value: "18", status: "CONFORME" }] } });
    expect(res.status).toBe(201);
    const old = res.body.data;
    created.push(old.id);
    const meta = cfg.parameters.find((p) => p.key === "etat_impression");
    const row = (readingId, value, status) => ({ qualityControlId: old.id, readingId, parameterKey: "etat_impression", parameterName: meta.label, position: meta.position, value, status });
    await QualityControlItem.bulkCreate([row(null, "Non conforme", "NON_CONTROLE"), row(old.readingId, "Non conforme", "NON_CONFORME")]);
    const stored = () => sql(`SELECT value, ("readingId" IS NULL) AS fiche FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" = 'etat_impression' ORDER BY 2`, { id: old.id });
    const before = await stored();
    expect(before).toHaveLength(2);

    const detail = (await get(`/quality-control/${old.id}`)).body.data;
    expect(detail.physicalParameters.map((p) => p.parameterKey)).toEqual(P4_PRODUCT_KEYS);
    expect(detail.readings[0].items.map((i) => i.parameterKey)).toEqual(KEYS);
    // Ni compté, ni non-conformité : la fiche se valide sur ses contrôles actuels.
    expect(detail.counts).toMatchObject({ total: 9, controlled: 1, nonConformes: 0 });
    expect(detail.nonConformParameters).toEqual([]);
    const v = await post(`/quality-control/${old.id}/validate`, { status: "CONFORME" });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ isValidated: true, status: "CONFORME" });
    expect(await stored()).toEqual(before);
  });

  test("PROMESH 4 : paramètres de la ligne refusés ; nouveau prélèvement = mêmes 9 champs, vides ; contrôle produit conservé", async () => {
    for (const parameterKey of LINE_ONLY) {
      const r = await put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`, { items: [{ parameterKey, value: "1", status: "CONFORME" }] });
      expect(r.status).toBe(400);
    }
    const r2 = await post(`/quality-control/${fiche.id}/readings`, { readingTime: "11:00", items: [{ parameterKey: "promesh4_temperature_machine_1_zone_1", value: "184", status: "CONFORME" }] });
    expect(r2.status).toBe(201);
    const c = r2.body.data;
    for (const r of c.readings) expect(r.items.map((i) => i.parameterKey)).toEqual(KEYS);
    expect(valuesOf(c.readings[1])).toEqual({ promesh4_temperature_machine_1_zone_1: "184" });
    expect(valuesOf(c.readings[0]).promesh4_temperature_machine_1_zone_1).toBe("182"); // ancien prélèvement jamais écrasé
    expect(c.counts).toMatchObject({ total: 18, controlled: 10, nonConformes: 0 });
    // Contrôle produit : non recréé, valeurs conservées.
    expect(c.physicalParameters.find((p) => p.parameterKey === "promesh_diametre_reel").value).toBe("Ø 6,1");
    const [{ n }] = await sql(`SELECT COUNT(*)::int n FROM quality_control_items WHERE "qualityControlId" = :id AND "readingId" IS NULL`, { id: fiche.id });
    expect(n).toBe(6);
    const stored = await sql(`SELECT DISTINCT "parameterKey" k FROM quality_control_items WHERE "qualityControlId" = :id`, { id: fiche.id });
    expect(stored.every((r) => [...KEYS, ...P4_PRODUCT_KEYS].includes(r.k))).toBe(true);

    // Validation de la fiche : résultat calculé sur les contrôles machine de PROMESH 4.
    const v = await post(`/quality-control/${fiche.id}/validate`, { status: "CONFORME" });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ isValidated: true, status: "CONFORME" });
    expect((await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "promesh_diametre_reel", value: "6" }] })).status).toBe(403);
  });

  test("PROMESH 1 / 2 / 3 et PROBAR 4 : listes inchangées ; les paramètres de PROMESH 4 y sont refusés", async () => {
    const other = await post("/quality-control", { productionType: "PROMESH", machine: "3", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [{ parameterKey: "temperature_machine", value: "8", status: "CONFORME" }] } });
    expect(other.status).toBe(201);
    created.push(other.body.data.id);
    expect(other.body.data.readings[0].items.map((i) => i.parameterKey)).toEqual(cfg.readingParametersFor("PROMESH").map((p) => p.key));
    expect(other.body.data.physicalParameters.map((p) => p.parameterKey)).toEqual(PRODUCT);
    expect(other.body.data.physicalParameters.map((p) => p.parameterName)).toContain("DIMENSIONS CÔTÉ 1 LONG"); // libellé de la ligne, pas celui de PROMESH 4
    const refused = await put(`/quality-control/${other.body.data.id}/readings/${other.body.data.readingId}`, { items: [{ parameterKey: "promesh4_vitesse_tirage", value: "3", status: "CONFORME" }] });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("UNKNOWN_PARAMETER");
    // Vitesse de tirage et autres contrôles machine de PROMESH 4 : refusés ; le diamètre réel est commun.
    expect((await put(`/quality-control/${other.body.data.id}`, { physical: [{ parameterKey: "promesh_diametre_reel", value: "6" }] })).status).toBe(200);

    const probar = await post("/quality-control", { productionType: "PROBAR", machine: "4", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [{ parameterKey: "nombre_bobines", value: "20", status: "CONFORME" }] } });
    expect(probar.status).toBe(201);
    created.push(probar.body.data.id);
    expect(probar.body.data.readings[0].items).toHaveLength(15);
    expect(probar.body.data.physicalParameters).toHaveLength(7);
    expect((await put(`/quality-control/${probar.body.data.id}/readings/${probar.body.data.readingId}`, { items: [{ parameterKey: "promesh4_nombre_bobines", value: "3", status: "CONFORME" }] })).status).toBe(400);
  });
});
