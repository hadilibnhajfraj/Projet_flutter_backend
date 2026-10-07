"use strict";

// Module CONTRÔLE QUALITÉ — PROMESH : CONTRÔLE MACHINE / CONTRÔLE PRODUIT.
//
// Un prélèvement PROMESH porte les 8 contrôles de la MACHINE (une seule
// catégorie « Contrôle Machine »), avec ses propres valeurs ; un nouveau
// prélèvement n'écrase jamais un ancien.
// Le CONTRÔLE PRODUIT (7 caractéristiques du produit) est de niveau FICHE :
// saisi une seule fois, commun aux prélèvements, jamais recréé par prélèvement.
// Les valeurs saisies dans un prélèvement avant cette séparation restent en
// base et sont reprises à l'affichage tant que la fiche n'a pas sa valeur.
// PROBAR n'est pas concerné : ses listes sont vérifiées inchangées.
//
// Fiches créées à une date lointaine (2035), supprimées en afterAll.

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
const ExcelJS = require("exceljs");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const cfg = require("../src/config/qualityControl");
const QualityControlItem = require("../src/models/QualityControlItem");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const DAY = "2035-08-21";
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];

const binary = (res, cb) => {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => cb(null, Buffer.from(data, "binary")));
};

// Contrôle Machine PROMESH (prélèvement), dans l'ordre d'affichage.
const MACHINE = [
  ["temperature_machine", "TEMPÉRATURE DE MACHINE"],
  ["temperature_eau", "TEMPÉRATURE D'EAU"],
  ["pression_air_comprime", "PRESSION D'AIR COMPRIMÉ"],
  ["fuite_eau", "FUITE D'EAU"],
  ["fuite_air_comprime", "FUITE D'AIR COMPRIMÉ"],
  ["etat_disque_coupe", "ÉTAT DISQUE DE COUPE"],
  ["niveau_bain_graines", "NIVEAU BAIN DE GRAINES"],
  ["vitesse_impression", "VITESSE D'IMPRESSION"],
];
// Contrôle Produit PROMESH (fiche), dans l'ordre demandé.
const PRODUCT = [
  ["promesh_diametre_reel", "DIAMÈTRE RÉEL"],
  ["nombre_bar_longueur", "NOMBRE DE BARRES EN LONGUEUR"],
  ["nombre_bar_largeur", "NOMBRE DE BARRES EN LARGEUR"],
  ["dimensions_maille", "DIMENSIONS DE MAILLE"],
  ["dimensions_cote_1_long", "DIMENSIONS CÔTÉ 1 LONG"],
  ["dimensions_cote_2_long", "DIMENSIONS CÔTÉ 2 LONG"],
  ["etat_impression", "ÉTAT D'IMPRESSION"],
];
const KEYS = MACHINE.map(([key]) => key);
const LABELS = MACHINE.map(([, label]) => label);
const PRODUCT_KEYS = PRODUCT.map(([key]) => key);
const PRODUCT_LABELS = PRODUCT.map(([, label]) => label);
// Retirés de PROMESH (ajoutés par les versions précédentes).
const REMOVED = [
  "diametre_bar",
  "vitesse_tirage",
  "vitesse_alimentation_fibres",
  "vitesse_barre",
  "temperature_zone_1",
  "pression_air",
  "alignement_fibres",
  "tension_rovings",
  "nombre_rovings",
  "temperature_zones_chauffage",
  "temperature_filiere",
  "pression_impregnation",
  "viscosite_resine",
  "ratio_resine_durcisseur_catalyseur",
  "temps_gel",
  "degre_polymerisation",
  "vitesse_polymerisation",
  "vitesse_refroidissement",
];
const REMOVED_FICHE = ["treillis_largeur", "treillis_longueur", "treillis_maille_longitudinale", "treillis_maille_transversale", "treillis_poids_m2", "treillis_rectitude_planeite", "treillis_tolerance_dimensionnelle", "treillis_espacement_fils"];

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

describe("Contrôle Qualité PROMESH — contrôle machine (prélèvement) et contrôle produit (fiche)", () => {
  let qc;
  let fiche;

  const post = (path, body) => request(app).post(path).set(auth(qc)).send(body);
  const put = (path, body) => request(app).put(path).set(auth(qc)).send(body);
  const get = (path) => request(app).get(path).set(auth(qc));
  const product = (c) => Object.fromEntries(c.physicalParameters.map((p) => [p.parameterKey, p]));
  const ficheRows = (id) => sql(`SELECT "parameterKey" k, value FROM quality_control_items WHERE "qualityControlId" = :id AND "readingId" IS NULL ORDER BY position`, { id });
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

  test("configuration : 8 contrôles machine par prélèvement (une catégorie) ; 7 caractéristiques produit au niveau fiche", async () => {
    const promesh = cfg.readingParametersFor("PROMESH");
    expect(promesh.map((p) => p.key)).toEqual(KEYS);
    expect(promesh.map((p) => p.label)).toEqual(LABELS);
    expect(new Set(promesh.map((p) => p.section))).toEqual(new Set(["controle_machine"]));
    expect(cfg.physicalParameters("PROMESH").map((p) => p.key)).toEqual(PRODUCT_KEYS);
    expect(cfg.physicalParameters("PROMESH").map((p) => p.label)).toEqual(PRODUCT_LABELS);
    expect(cfg.ficheParameters("PROMESH").map((p) => p.key)).toEqual(PRODUCT_KEYS);
    expect(cfg.specificParameters("PROMESH")).toEqual([]);

    // L'API : la liste PROMESH est celle-là et rien d'autre.
    const { data } = (await get("/quality-control/config")).body;
    const api = data.parameters.filter((p) => p.lines.includes("PROMESH"));
    expect(api).toHaveLength(15);
    const machine = api.filter((p) => p.scope === "reading");
    expect(machine.every((p) => p.byLine.PROMESH.section === "controle_machine")).toBe(true);
    expect([...machine].sort((a, b) => a.byLine.PROMESH.order - b.byLine.PROMESH.order).map((p) => p.byLine.PROMESH.label)).toEqual(LABELS);
    // Ordre du contrôle produit : celui de la ligne (byLine.PROMESH.order), diamètre réel en premier.
    const productApi = api.filter((p) => p.scope === "fiche");
    expect([...productApi].sort((x, y) => x.byLine.PROMESH.order - y.byLine.PROMESH.order).map((p) => [p.key, p.section])).toEqual(PRODUCT_KEYS.map((k) => [k, "physique"]));
    expect(api.filter((p) => p.scope === "fiche").every((p) => p.lines[0] === "PROMESH")).toBe(true);
    expect(data.sections.find((s) => s.key === "controle_machine")).toMatchObject({ label: "Contrôle Machine" });
    expect(data.sections.find((s) => s.key === "physique")).toMatchObject({ label: "Contrôle produit", scope: "fiche" });
    expect(data.sections.find((s) => s.key === "prelevement")).toBeUndefined();
    // Types de saisie.
    const by = Object.fromEntries(data.parameters.map((p) => [p.key, p]));
    expect(by.niveau_bain_graines.options.map((o) => o.value)).toEqual(["Bien", "Moyen", "Mauvais"]);
    expect(by.diametre_bar).toBeUndefined();
    expect(by.temperature_machine).toMatchObject({ kind: "number", unit: "°C" });
    expect(by.fuite_eau.options.map((o) => o.value)).toEqual(["Absent", "Présent"]);
    expect(by.etat_disque_coupe.options.map((o) => o.value)).toEqual(["OK", "NOK"]);
    expect(by.nombre_bar_longueur).toMatchObject({ kind: "number", unit: null });
    expect(by.nombre_bar_largeur).toMatchObject({ kind: "number", unit: null });
    expect(by.dimensions_maille).toMatchObject({ kind: "text", hint: "ex. 20 × 20 mm" });
    expect(by.dimensions_cote_1_long).toMatchObject({ kind: "number", unit: "mm" });
    expect(by.dimensions_cote_2_long).toMatchObject({ kind: "number", unit: "mm" });
    expect(by.etat_impression).toMatchObject({ kind: "choice" });
    expect(by.etat_impression.options.map((o) => o.value)).toEqual(["Conforme", "Non conforme"]);
    // Vitesse d'impression : contrôle MACHINE du prélèvement ; diamètre réel : contrôle PRODUIT de la fiche.
    expect(by.vitesse_impression).toMatchObject({ kind: "number", unit: null, scope: "reading" }); // aucune unité inventée
    expect(by.vitesse_impression.byLine.PROMESH).toMatchObject({ section: "controle_machine", order: 8 });
    expect(by.promesh_diametre_reel).toMatchObject({ kind: "text", unit: null, scope: "fiche", section: "physique" });
  });

  test("PROBAR non affecté par la règle PROMESH : ses contrôles, catégories, libellés et paramètres physiques", () => {
    const probar = cfg.readingParametersFor("PROBAR");
    expect(probar.map((p) => [p.key, p.section])).toEqual([
      ["variateur_frequence_tirage", "ligne"],
      ["variateur_frequence_bobinage", "ligne"],
      ["vitesse_barre", "ligne"],
      ["nombre_bobines", "ligne"],
      ["alignement_fibres", "ligne"],
      ["temperature_zone_1", "chauffage"],
      ["temperature_zone_2", "chauffage"],
      ["temperature_zone_3", "chauffage"],
      ["pression_air", "chauffage"],
      ["viscosite_resine", "chauffage"],
      ["ratio_resine_durcisseur_catalyseur", "chauffage"],
      ["temperature_eau", "machine"],
      ["fuite_air_comprime", "machine"],
      ["fuite_eau", "machine"],
      ["etat_disque_coupe", "machine"],
    ]);
    // Un paramètre partagé garde son libellé PROBAR.
    expect(probar.find((p) => p.key === "etat_disque_coupe").label).toBe("ÉTAT DU DISQUE DE COUPE");
    expect(cfg.physicalParameters("PROBAR").map((p) => p.key)).toEqual([
      "phys_diametre_nominal",
      "phys_diametre_reel",
      "phys_section_transversale",
      "phys_longueur",
      "phys_masse_lineique",
      "phys_defauts_superficiels_controle",
      "phys_qualite_coupe",
    ]);
    expect(cfg.specificParameters("PROBAR")).toEqual([]);
  });

  test("prélèvement 1 — 08:00 : les 8 contrôles machine ; contrôle produit saisi UNE fois au niveau de la fiche", async () => {
    const res = await post("/quality-control", {
      productionType: "PROMESH",
      machine: "3",
      productionDate: DAY,
      poste: "matin",
      reading: {
        readingTime: "08:00",
        items: [
          { parameterKey: "niveau_bain_graines", value: "Bien", status: "CONFORME" },
          { parameterKey: "temperature_machine", value: "8", status: "CONFORME" },
          { parameterKey: "pression_air_comprime", value: "4", status: "NON_CONFORME", remark: "pression basse" },
        ],
      },
    });
    expect(res.status).toBe(201);
    fiche = res.body.data;
    created.push(fiche.id);

    const items = fiche.readings[0].items;
    expect(items.map((i) => i.parameterKey)).toEqual(KEYS);
    expect(items.map((i) => i.parameterName)).toEqual(LABELS);
    expect(fiche.readings[0].counts).toMatchObject({ total: 8, controlled: 3, nonConformes: 1 });
    expect(items.find((i) => i.parameterKey === "pression_air_comprime")).toMatchObject({ value: "4", status: "NON_CONFORME", remark: "pression basse" });
    expect(fiche.nonConformParameters).toEqual(["PRESSION D'AIR COMPRIMÉ"]);
    // Contrôle produit : niveau fiche, vide à la création.
    expect(fiche.physicalParameters.map((p) => p.parameterKey)).toEqual(PRODUCT_KEYS);
    expect(fiche.physicalParameters.map((p) => p.parameterName)).toEqual(PRODUCT_LABELS);
    expect(fiche.physicalParameters.every((p) => p.value === null)).toBe(true);
    expect(fiche.specificParameters).toEqual([]);
    expect(fiche).toMatchObject({ machine: "3", productionDate: DAY, poste: "matin", controllerEmail: QC_EMAIL });
    expect(fiche.reference).toMatch(/^QC-PROMESH-\d{6}$/);

    // Une caractéristique du produit n'est jamais acceptée dans un prélèvement.
    for (const parameterKey of PRODUCT_KEYS) {
      const r = await put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`, { items: [{ parameterKey, value: "Conforme", status: "CONFORME" }] });
      expect(r.status).toBe(400);
    }

    // Saisie du contrôle produit : une ligne par paramètre, sans prélèvement.
    const input = { nombre_bar_longueur: "15", nombre_bar_largeur: "9", dimensions_maille: "20 × 20 mm", dimensions_cote_1_long: "2400", promesh_diametre_reel: "6,1", dimensions_cote_2_long: "1200", etat_impression: "Conforme" };
    const saved = await put(`/quality-control/${fiche.id}`, { physical: PRODUCT_KEYS.map((k) => ({ parameterKey: k, value: input[k] })) });
    expect(saved.status).toBe(200);
    expect(Object.fromEntries(saved.body.data.physicalParameters.map((p) => [p.parameterKey, p.value]))).toEqual(input);
    expect(product(saved.body.data).etat_impression).toMatchObject({ value: "Conforme", displayValue: "Conforme", inherited: false });
    expect(Object.fromEntries((await ficheRows(fiche.id)).map((r) => [r.k, r.value]))).toEqual(input);
    expect(await ficheRows(fiche.id)).toHaveLength(7);
    // État d'impression : Conforme / Non conforme uniquement.
    const bad = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "etat_impression", value: "moyen" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_VALUE");
    const nc = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "etat_impression", value: "Non conforme" }] });
    expect(product(nc.body.data).etat_impression.value).toBe("Non conforme");
  });

  test("paramètres retirés : refusés dans un prélèvement comme au niveau de la fiche ; rien n'est écrit", async () => {
    for (const parameterKey of REMOVED) {
      const r = await put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`, { items: [{ parameterKey, value: "1", status: "CONFORME" }] });
      expect(r.status).toBe(400);
    }
    for (const parameterKey of REMOVED_FICHE) {
      expect((await put(`/quality-control/${fiche.id}`, { specific: [{ parameterKey, value: "1", status: "CONFORME" }] })).status).toBe(400);
      expect((await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey, value: "1" }] })).status).toBe(400);
    }
    const stored = await sql(`SELECT DISTINCT "parameterKey" k FROM quality_control_items WHERE "qualityControlId" = :id`, { id: fiche.id });
    expect(stored.every((r) => [...KEYS, ...PRODUCT_KEYS].includes(r.k))).toBe(true);
  });

  test("prélèvements 2 (12:00) et 3 (16:00) : mêmes contrôles machine, nouvelles valeurs ; contrôle produit jamais recréé, valeurs conservées", async () => {
    const before = await ficheRows(fiche.id);
    const r2 = await post(`/quality-control/${fiche.id}/readings`, { readingTime: "12:00", items: [{ parameterKey: "temperature_machine", value: "8.2", status: "CONFORME" }, { parameterKey: "pression_air_comprime", value: "6", status: "CONFORME" }] });
    const r3 = await post(`/quality-control/${fiche.id}/readings`, { readingTime: "16:00", items: [{ parameterKey: "temperature_machine", value: "8.1", status: "CONFORME" }] });
    expect([r2.status, r3.status]).toEqual([201, 201]);
    const c = r3.body.data;
    expect(c.readings.map((r) => [r.step, r.readingTime])).toEqual([[1, "08:00"], [2, "12:00"], [3, "16:00"]]);
    for (const r of c.readings) {
      expect(r.items.map((i) => i.parameterKey)).toEqual(KEYS);
      expect(r.counts.total).toBe(8);
    }
    // Chaque prélèvement garde ses propres valeurs.
    expect(valuesOf(c.readings[0])).toEqual({ niveau_bain_graines: "Bien", temperature_machine: "8", pression_air_comprime: "4" });
    expect(valuesOf(c.readings[1])).toEqual({ temperature_machine: "8.2", pression_air_comprime: "6" });
    expect(valuesOf(c.readings[2])).toEqual({ temperature_machine: "8.1" });
    expect(c.counts).toMatchObject({ total: 24, controlled: 6, nonConformes: 1 });
    // Contrôle produit : mêmes lignes de niveau fiche, aucune recréée par les prélèvements.
    expect(await ficheRows(fiche.id)).toEqual(before);
    expect(product(c).nombre_bar_longueur.value).toBe("15");
    expect(product(c).etat_impression.value).toBe("Non conforme");
    // Modification d'une caractéristique : même ligne, les autres intactes.
    const upd = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "promesh_diametre_reel", value: "6,2" }] });
    expect(upd.status).toBe(200);
    const after = await ficheRows(fiche.id);
    expect(after).toHaveLength(7);
    expect(after.find((r) => r.k === "promesh_diametre_reel").value).toBe("6,2");
    expect(after.filter((r) => r.k !== "promesh_diametre_reel")).toEqual(before.filter((r) => r.k !== "promesh_diametre_reel"));
  });

  test("export et comparaison : contrôle machine dans les paramètres, contrôle produit à part ; validation → lecture seule", async () => {
    const detail = (await get(`/quality-control/${fiche.id}`)).body.data;
    const x = await get(`/quality-control/export?format=xlsx&search=${encodeURIComponent(fiche.reference)}`).buffer(true).parse(binary);
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    const rows = [];
    wb.getWorksheet("Paramètres").eachRow((r, i) => i > 4 && rows.push(r.values.slice(1)));
    const exported = rows.filter((r) => r[0] === fiche.reference).map((r) => r[4]);
    expect(exported).toHaveLength(6);
    expect(exported.every((label) => LABELS.includes(label))).toBe(true);
    const physical = [];
    wb.getWorksheet("Contrôle produit").eachRow((r, i) => i > 4 && physical.push(r.values.slice(1)));
    const mine = physical.filter((r) => r[0] === fiche.reference);
    expect(mine.map((r) => r[3])).toEqual(PRODUCT_LABELS); // une seule fois par fiche
    expect(mine.find((r) => r[3] === "NOMBRE DE BARRES EN LONGUEUR")[4]).toBe("15");
    expect(mine.find((r) => r[3] === "ÉTAT D'IMPRESSION")[4]).toBe("Non conforme");

    // Comparaison : uniquement les contrôles machine du prélèvement.
    const opened = detail.controlDate.split("/").reverse().join("-");
    const cmp = (await get(`/quality-control/comparison?periodAStart=${opened}&periodAEnd=${opened}&periodBStart=${opened}&periodBEnd=${opened}&productionType=PROMESH&machine=3`)).body.data;
    expect(cmp.parameters.length).toBeGreaterThan(0);
    expect(cmp.parameters.every((p) => KEYS.includes(p.key) && p.group === "releve" && p.sectionLabel === "Contrôle Machine")).toBe(true);

    const v = await post(`/quality-control/${fiche.id}/validate`, { status: "CONFORME" });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ isValidated: true, status: "NON_CONFORME" }); // pression d'air comprimé non conforme
    expect((await put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`, { items: [{ parameterKey: "temperature_machine", value: "9", status: "CONFORME" }] })).status).toBe(403);
    expect((await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "promesh_diametre_reel", value: "7" }] })).status).toBe(403);
    expect(product((await get(`/quality-control/${fiche.id}`)).body.data).promesh_diametre_reel.value).toBe("6,2");
  });

  test("anciennes fiches : caractéristiques saisies dans un prélèvement conservées en base et reprises au niveau fiche ; paramètres retirés masqués", async () => {
    const res = await post("/quality-control", { productionType: "PROMESH", machine: "3", productionDate: DAY, poste: "soir", reading: { readingTime: "08:00", items: [{ parameterKey: "temperature_machine", value: "8", status: "CONFORME" }] } });
    expect(res.status).toBe(201);
    const old = res.body.data;
    created.push(old.id);
    const r2 = (await post(`/quality-control/${old.id}/readings`, { readingTime: "12:00", items: [{ parameterKey: "temperature_machine", value: "8.3", status: "CONFORME" }] })).body.data;
    // Valeurs saisies AVANT la séparation (écrites directement en base, dans les prélèvements).
    const meta = (key) => cfg.parameters.find((p) => p.key === key);
    const row = (readingId, key, value, status) => ({ qualityControlId: old.id, readingId, parameterKey: key, parameterName: meta(key).label, position: meta(key).position, value, status });
    await QualityControlItem.bulkCreate([
      row(old.readingId, "nombre_bar_longueur", "15", "CONFORME"),
      row(r2.readingId, "nombre_bar_longueur", "16", "CONFORME"),
      row(old.readingId, "dimensions_cote_1_long", "2400", "NON_CONFORME"),
      row(old.readingId, "etat_impression", "Conforme", "CONFORME"),
      row(old.readingId, "vitesse_tirage", "20", "NON_CONFORME"),
      row(null, "treillis_largeur", "2400", "NON_CONFORME"),
    ]);
    const legacy = () => sql(`SELECT "parameterKey" k, value, ("readingId" IS NULL) AS fiche FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" <> 'temperature_machine' ORDER BY 1, 2`, { id: old.id });
    const before = await legacy();
    expect(before).toHaveLength(6);

    const detail = (await get(`/quality-control/${old.id}`)).body.data;
    // Prélèvements : uniquement le contrôle machine ; les anciennes lignes ne sont ni affichées ni comptées.
    for (const r of detail.readings) expect(r.items.map((i) => i.parameterKey)).toEqual(KEYS);
    expect(detail.counts).toMatchObject({ total: 16, controlled: 2, nonConformes: 0 });
    expect(detail.nonConformParameters).toEqual([]);
    expect(detail.specificParameters).toEqual([]);
    // Contrôle produit : valeur du DERNIER prélèvement qui la portait, signalée comme reprise.
    expect(product(detail).nombre_bar_longueur).toMatchObject({ value: "16", inherited: true });
    expect(product(detail).dimensions_cote_1_long).toMatchObject({ value: "2400", inherited: true });
    expect(product(detail).etat_impression).toMatchObject({ value: "Conforme", displayValue: "Conforme", inherited: true });
    expect(product(detail).promesh_diametre_reel).toMatchObject({ value: null, inherited: false });
    expect(product(detail).vitesse_impression).toBeUndefined();
    expect(product(detail).dimensions_cote_2_long).toMatchObject({ value: null, inherited: false });

    // La fiche reste modifiable : la valeur saisie au niveau fiche prime ; rien n'est supprimé.
    const upd = await put(`/quality-control/${old.id}`, { physical: [{ parameterKey: "nombre_bar_longueur", value: "17" }] });
    expect(upd.status).toBe(200);
    expect(product(upd.body.data).nombre_bar_longueur).toMatchObject({ value: "17", inherited: false });
    expect((await legacy()).filter((r) => !r.fiche || r.k !== "nombre_bar_longueur")).toEqual(before);
  });
});
