"use strict";

// Module CONTRÔLE QUALITÉ — CONTRÔLE PRODUIT PROBAR (7 paramètres).
//
// Niveau fiche : saisis UNE fois, communs à tous les prélèvements.
//   Diamètre nominal, Diamètre réel, Section transversale, Ovalisation,
//   Longueur, Masse linéique, Rectitude, Pas du profil de surface, Défauts
//   superficiels, Vitesse de refroidissement, Qualité de coupe, Ceinture de
//   tirage.
// « Qualité de coupe » est un CHOIX (BON | PAS_BON), jamais une saisie libre.
// Retirés : vitesse de coupe, longueur de coupe, hauteur / profondeur des
// nervures, régularité du revêtement — valeurs historiques conservées en
// base, plus affichées. PROMESH inchangé.
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
const DAY = "2035-07-03";
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];

const binary = (res, cb) => {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => cb(null, Buffer.from(data, "binary")));
};

const LABELS = [
  "DIAMÈTRE NOMINAL",
  "DIAMÈTRE RÉEL",
  "SECTION TRANSVERSALE",
  "LONGUEUR",
  "POIDS EN g",
  "DÉFAUTS SUPERFICIELS",
  "QUALITÉ DE COUPE",
];
// Retirés des paramètres physiques PROBAR (clé → libellé).
const REMOVED = {
  phys_vitesse_coupe: "VITESSE DE COUPE",
  phys_longueur_coupe: "LONGUEUR DE COUPE",
  phys_hauteur_nervures: "HAUTEUR / PROFONDEUR DES NERVURES OU ENROULEMENT",
  phys_regularite_revetement: "RÉGULARITÉ DU REVÊTEMENT",
  phys_ovalisation: "OVALISATION",
  phys_rectitude: "RECTITUDE",
  phys_vitesse_refroidissement: "VITESSE DE REFROIDISSEMENT",
  phys_ceinture_tirage: "CEINTURE DE TIRAGE",
};
const KEYS = cfg.physicalParameters("PROBAR").map((p) => p.key);

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

describe("Contrôle Qualité — contrôle produit PROBAR : 7 paramètres, qualité de coupe Bon / Pas bon", () => {
  let qc;
  let fiche;

  const post = (path, body) => request(app).post(path).set(auth(qc)).send(body);
  const put = (path, body) => request(app).put(path).set(auth(qc)).send(body);
  const get = (path) => request(app).get(path).set(auth(qc));
  const physicalRows = (id) => sql(`SELECT "parameterKey" k, value FROM quality_control_items WHERE "qualityControlId" = :id AND "readingId" IS NULL ORDER BY position`, { id });
  const byKey = (c) => Object.fromEntries(c.physicalParameters.map((p) => [p.parameterKey, p]));
  const values = (c) => Object.fromEntries(c.physicalParameters.map((p) => [p.parameterKey, p.value]));
  // Compteur « X / Y renseigné(s) », tel que l'écran le calcule.
  const filled = (c) => `${c.physicalParameters.filter((p) => p.value != null && String(p.value).trim() !== "").length} / ${c.physicalParameters.length}`;

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

  test("configuration : 7 paramètres du contrôle produit PROBAR ; qualité de coupe = choix Bon / Pas bon ; PROMESH inchangé", async () => {
    const { data } = (await get("/quality-control/config")).body;
    const physical = data.parameters.filter((p) => p.scope === "fiche" && p.section === "physique" && p.lines.includes("PROBAR"));
    expect(physical.map((p) => p.label)).toEqual(LABELS);
    const by = Object.fromEntries(data.parameters.map((p) => [p.key, p]));
    // Qualité de coupe : choix exclusif, jamais numérique, sans unité.
    expect(by.phys_qualite_coupe).toMatchObject({ kind: "choice", scope: "fiche", lines: ["PROBAR"], unit: null, withStatus: false });
    expect(by.phys_qualite_coupe.options.map((o) => [o.value, o.label])).toEqual([["BON", "Bon"], ["PAS_BON", "Pas bon"]]);
    // Retirés : plus renvoyés par l'API.
    for (const key of Object.keys(REMOVED)) expect(by[key]).toBeUndefined();
    // Défauts superficiels : choix OK / NOK (nouvelle clé) ; l'ancienne saisie libre n'est plus renvoyée.
    expect(by.phys_defauts_superficiels_controle).toMatchObject({ label: "DÉFAUTS SUPERFICIELS", kind: "choice", scope: "fiche", lines: ["PROBAR"], unit: null });
    expect(by.phys_defauts_superficiels_controle.options.map((o) => [o.value, o.label])).toEqual([["OK", "OK"], ["NOK", "NOK"]]);
    expect(by.phys_defauts_superficiels).toBeUndefined();
    expect(by.phys_pas_profil_surface_controle).toBeUndefined();
    expect(by.phys_pas_profil_surface).toBeUndefined();
    // « Masse linéique » renommée « Poids en g » : même clé, saisie libre.
    expect(by.phys_masse_lineique).toMatchObject({ label: "POIDS EN g", kind: "text", unit: null });
    expect(data.sections.find((x) => x.key === "physique").label).toBe("Contrôle produit");
    // Prélèvements PROBAR : ligne 5, chauffage 6, machine 4.
    const reading = (type) => data.parameters.filter((p) => p.scope === "reading" && p.lines.includes(type));
    expect(reading("PROBAR")).toHaveLength(15);

    // PROMESH : 8 contrôles machine par prélèvement, 7 caractéristiques produit au niveau fiche.
    expect(reading("PROMESH")).toHaveLength(8);
    expect(cfg.ficheParameters("PROMESH")).toHaveLength(7);
  });

  test("nouvelle fiche PROBAR : 7 champs vides, aucune qualité sélectionnée ; saisie, sauvegarde, rechargement", async () => {
    const res = await post("/quality-control", { productionType: "PROBAR", machine: "4", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [{ parameterKey: "nombre_bobines", value: "24", status: "CONFORME" }] } });
    expect(res.status).toBe(201);
    fiche = res.body.data;
    created.push(fiche.id);
    expect(fiche.physicalParameters.map((p) => p.parameterName)).toEqual(LABELS);
    for (const label of Object.values(REMOVED)) expect(fiche.physicalParameters.map((p) => p.parameterName)).not.toContain(label);
    expect(fiche.physicalParameters.every((p) => p.value === null && p.displayValue === null)).toBe(true);
    expect(filled(fiche)).toBe("0 / 7");

    // Saisie des 7 paramètres ; qualité de coupe : BON.
    const input = Object.fromEntries(KEYS.map((k, i) => [k, `v${i + 1}`]));
    Object.assign(input, { phys_masse_lineique: "152.4", phys_defauts_superficiels_controle: "OK", phys_qualite_coupe: "BON" });
    const saved = await put(`/quality-control/${fiche.id}`, { physical: KEYS.map((k) => ({ parameterKey: k, value: input[k] })) });
    expect(saved.status).toBe(200);
    expect(filled(saved.body.data)).toBe("7 / 7");

    // Rechargement depuis la base : qualité de coupe restaurée (valeur + libellé).
    const reopened = (await get(`/quality-control/${fiche.id}`)).body.data;
    expect(values(reopened)).toEqual(input);
    expect(byKey(reopened).phys_qualite_coupe).toMatchObject({ value: "BON", displayValue: "Bon" });
    expect(byKey(reopened).phys_defauts_superficiels_controle).toMatchObject({ value: "OK", displayValue: "OK" });
    expect(byKey(reopened).phys_masse_lineique).toMatchObject({ parameterName: "POIDS EN g", value: "152.4", displayValue: "152.4" });
    const rows = await physicalRows(fiche.id);
    expect(rows.map((r) => r.k)).toEqual(KEYS);
    expect(rows.find((r) => r.k === "phys_qualite_coupe").value).toBe("BON");
  });

  test("qualité de coupe : un seul choix (BON ou PAS_BON), modifiable, effaçable ; toute autre valeur refusée", async () => {
    const pasBon = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_qualite_coupe", value: "PAS_BON" }] });
    expect(pasBon.status).toBe(200);
    expect(byKey(pasBon.body.data).phys_qualite_coupe).toMatchObject({ value: "PAS_BON", displayValue: "Pas bon" });
    // Une seule ligne en base : le choix remplace le précédent.
    expect((await physicalRows(fiche.id)).filter((r) => r.k === "phys_qualite_coupe")).toEqual([{ k: "phys_qualite_coupe", value: "PAS_BON" }]);

    for (const value of ["2.5", "bon", "Bon", "OUI"]) {
      const bad = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_qualite_coupe", value }] });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("INVALID_VALUE");
    }
    expect(values((await get(`/quality-control/${fiche.id}`)).body.data).phys_qualite_coupe).toBe("PAS_BON");

    // Aucune sélection : champ vidé, compteur recalculé.
    const cleared = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_qualite_coupe", value: "" }] });
    expect(cleared.status).toBe(200);
    expect(byKey(cleared.body.data).phys_qualite_coupe).toMatchObject({ value: null, displayValue: null });
    expect(filled(cleared.body.data)).toBe("6 / 7");
    await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_qualite_coupe", value: "BON" }] });
  });

  test("défauts superficiels : choix OK / NOK enregistré avec la fiche, modifiable, effaçable ; aucune saisie libre", async () => {
    const nok = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_defauts_superficiels_controle", value: "NOK" }] });
    expect(nok.status).toBe(200);
    expect(byKey(nok.body.data).phys_defauts_superficiels_controle).toMatchObject({ parameterName: "DÉFAUTS SUPERFICIELS", value: "NOK", displayValue: "NOK" });
    // Une seule ligne en base : le choix remplace le précédent.
    expect((await physicalRows(fiche.id)).filter((r) => r.k === "phys_defauts_superficiels_controle")).toEqual([{ k: "phys_defauts_superficiels_controle", value: "NOK" }]);
    for (const value of ["2 rayures légères", "ok", "Conforme", "aucun"]) {
      const bad = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_defauts_superficiels_controle", value }] });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("INVALID_VALUE");
    }
    // L'ancienne saisie libre et l'ancien « pas du profil » ne sont plus acceptés.
    for (const parameterKey of ["phys_defauts_superficiels", "phys_pas_profil_surface_controle", "phys_pas_profil_surface"]) {
      const legacy = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey, value: "OK" }] });
      expect(legacy.status).toBe(400);
      expect(legacy.body.code).toBe("UNKNOWN_PARAMETER");
    }
    // Rechargement : le choix est relu depuis la base ; effacement possible, compteur recalculé.
    expect(values((await get(`/quality-control/${fiche.id}`)).body.data).phys_defauts_superficiels_controle).toBe("NOK");
    const cleared = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_defauts_superficiels_controle", value: "" }] });
    expect(byKey(cleared.body.data).phys_defauts_superficiels_controle).toMatchObject({ value: null, displayValue: null });
    expect(filled(cleared.body.data)).toBe("6 / 7");
    await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_defauts_superficiels_controle", value: "NOK" }] });
  });

  test("paramètres retirés : refusés à l'écriture ; jamais dans un prélèvement ; PROMESH n'accepte pas la qualité de coupe", async () => {
    for (const parameterKey of Object.keys(REMOVED)) {
      const r = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey, value: "1" }] });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("UNKNOWN_PARAMETER");
    }
    for (const parameterKey of ["phys_qualite_coupe", "phys_vitesse_refroidissement", "vitesse_coupe", "longueur_coupe"]) {
      const r = await put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`, { items: [{ parameterKey, value: "BON", status: "CONFORME" }] });
      expect(r.status).toBe(400);
    }
    const promesh = await post("/quality-control", { productionType: "PROMESH", machine: "2", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [{ parameterKey: "temperature_machine", value: "3", status: "CONFORME" }] } });
    expect(promesh.status).toBe(201);
    created.push(promesh.body.data.id);
    expect(promesh.body.data.physicalParameters.map((p) => p.parameterKey)).not.toContain("phys_qualite_coupe");
    expect((await put(`/quality-control/${promesh.body.data.id}`, { physical: [{ parameterKey: "phys_qualite_coupe", value: "BON" }] })).status).toBe(400);
  });

  test("deuxième prélèvement : paramètres physiques inchangés et jamais dupliqués ; export Excel avec le libellé ; validation → lecture seule", async () => {
    const before = await physicalRows(fiche.id);
    const r2 = await post(`/quality-control/${fiche.id}/readings`, { readingTime: "11:00", items: [{ parameterKey: "nombre_bobines", value: "26", status: "CONFORME" }] });
    expect(r2.status).toBe(201);
    expect(values(r2.body.data)).toMatchObject({ phys_qualite_coupe: "BON", phys_defauts_superficiels_controle: "NOK", phys_masse_lineique: "152.4" });
    expect(await physicalRows(fiche.id)).toEqual(before);
    for (const r of r2.body.data.readings) {
      expect(r.items).toHaveLength(15);
      expect(r.items.some((i) => i.parameterKey.startsWith("phys_"))).toBe(false);
    }

    const q = `search=${encodeURIComponent(fiche.reference)}`;
    const x = await get(`/quality-control/export?format=xlsx&${q}`).buffer(true).parse(binary);
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    const rows = [];
    wb.getWorksheet("Contrôle produit").eachRow((r, i) => i > 4 && rows.push(r.values.slice(1)));
    const mine = rows.filter((r) => r[0] === fiche.reference);
    expect(mine.map((r) => r[3])).toEqual(LABELS); // les 7, une seule fois, sans paramètre retiré
    expect(mine.find((r) => r[3] === "QUALITÉ DE COUPE")[4]).toBe("Bon"); // libellé, pas le code BON
    expect(mine.find((r) => r[3] === "POIDS EN g")[4]).toBe("152.4");
    expect(mine.find((r) => r[3] === "DÉFAUTS SUPERFICIELS")[4]).toBe("NOK");
    const pdf = await get(`/quality-control/export?format=pdf&${q}`).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.body.toString("latin1").startsWith("%PDF-")).toBe(true);

    const v = await post(`/quality-control/${fiche.id}/validate`, { status: "CONFORME" });
    expect(v.status).toBe(200);
    expect(byKey(v.body.data).phys_qualite_coupe).toMatchObject({ value: "BON", displayValue: "Bon" });
    const locked = await put(`/quality-control/${fiche.id}`, { physical: [{ parameterKey: "phys_qualite_coupe", value: "PAS_BON" }] });
    expect(locked.status).toBe(403);
    expect(values((await get(`/quality-control/${fiche.id}`)).body.data).phys_qualite_coupe).toBe("BON");
  });

  test("ancienne fiche PROBAR : valeurs des paramètres retirés conservées en base, plus affichées ni reprises", async () => {
    const res = await post("/quality-control", { productionType: "PROBAR", machine: "3", productionDate: DAY, poste: "soir", reading: { readingTime: "08:00", items: [{ parameterKey: "nombre_bobines", value: "20", status: "CONFORME" }] } });
    expect(res.status).toBe(201);
    const old = res.body.data;
    created.push(old.id);
    // Valeurs saisies AVANT la modification (écrites directement en base).
    const position = (key) => cfg.parameters.find((p) => p.key === key).position;
    const label = (key) => cfg.parameters.find((p) => p.key === key).label;
    const row = (readingId, parameterKey, value) => ({ qualityControlId: old.id, readingId, parameterKey, parameterName: label(parameterKey), position: position(parameterKey), value, status: readingId ? "CONFORME" : "NON_CONTROLE" });
    await QualityControlItem.bulkCreate([
      row(null, "phys_vitesse_coupe", "145"),
      row(null, "phys_longueur_coupe", "6000"),
      row(null, "phys_hauteur_nervures", "0.8"),
      row(null, "phys_regularite_revetement", "régulier"),
      row(null, "phys_rectitude", "droite"),
      row(null, "phys_pas_profil_surface", "10 mm"),
      row(null, "phys_pas_profil_surface_controle", "NOK"),
      row(null, "phys_defauts_superficiels", "2 rayures"),
      row(old.readingId, "vitesse_refroidissement", "12"),
      row(old.readingId, "vitesse_coupe", "140"),
    ]);
    const stored = () => sql(`SELECT "parameterKey" k, value FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" IN (:keys) ORDER BY 1`, { id: old.id, keys: [...Object.keys(REMOVED), "vitesse_refroidissement", "vitesse_coupe"] });
    const before = await stored();
    expect(before).toHaveLength(7);

    const detail = (await get(`/quality-control/${old.id}`)).body.data;
    expect(detail.physicalParameters.map((p) => p.parameterName)).toEqual(LABELS);
    for (const text of Object.values(REMOVED)) expect(detail.physicalParameters.map((p) => p.parameterName)).not.toContain(text);
    // Une ancienne vitesse de coupe n'est jamais relue comme une qualité de coupe.
    expect(byKey(detail).phys_qualite_coupe).toMatchObject({ value: null, displayValue: null, inherited: false });
    // Pas du profil de surface (saisie « 10 mm » puis choix « NOK ») : conservé en base, plus affiché,
    // jamais relu comme un défaut superficiel.
    expect(byKey(detail).phys_pas_profil_surface_controle).toBeUndefined();
    // Un ancien texte « Défauts superficiels » n'est jamais relu comme un choix OK / NOK ; il reste en base.
    expect(byKey(detail).phys_defauts_superficiels).toBeUndefined();
    expect(byKey(detail).phys_defauts_superficiels_controle).toMatchObject({ value: null, displayValue: null, inherited: false });
    expect(await sql(`SELECT value FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" = 'phys_defauts_superficiels'`, { id: old.id })).toEqual([{ value: "2 rayures" }]);
    expect(await sql(`SELECT "parameterKey" k, value FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" LIKE 'phys_pas_profil_surface%' ORDER BY 1`, { id: old.id })).toEqual([{ k: "phys_pas_profil_surface", value: "10 mm" }, { k: "phys_pas_profil_surface_controle", value: "NOK" }]);
    // Vitesse de refroidissement : retirée — plus affichée, plus reprise d'un ancien prélèvement.
    expect(byKey(detail).phys_vitesse_refroidissement).toBeUndefined();
    expect(filled(detail)).toBe("0 / 7");

    // La fiche reste modifiable ; rien n'est supprimé.
    const upd = await put(`/quality-control/${old.id}`, { physical: [{ parameterKey: "phys_qualite_coupe", value: "PAS_BON" }] });
    expect(upd.status).toBe(200);
    expect(byKey(upd.body.data).phys_qualite_coupe.displayValue).toBe("Pas bon");
    expect(await stored()).toEqual(before);
  });
});
