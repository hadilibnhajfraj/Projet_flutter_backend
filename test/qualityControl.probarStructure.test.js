"use strict";

// Module CONTRÔLE QUALITÉ — structure des paramètres PROBAR (barres GFRP),
// alignée sur le processus réel de fabrication.
//
// Prélèvement PROBAR (15 contrôles) :
//   A — Paramètres de ligne (5) : variateur en fréquence de tirage, variateur
//       en fréquence de bobinage, vitesse de barre (m/min), nombre de
//       bobines, alignement des fibres ;
//   B — Chauffage / imprégnation (6) : température zone 1, zone 2, zone 3
//       (trois valeurs enregistrées séparément), pression d'air, viscosité
//       de la résine, ratio résine / durcisseur / catalyseur (contrôle binaire
//       Conforme / Non conforme, sans valeur saisie) ;
//   Machine (4) : sans température de machine, pression d'air comprimé ni état
//       d'impression (PROMESH uniquement) ;
//   Machine (7) : inchangé. (Refroidissement / coupe : paramètres physiques
//   de la fiche — voir qualityControl.probarPhysical.test.js.)
// Retirés de PROBAR : niveau bain de graines, vitesse de tirage, tension et
// nombre de rovings, température de la filière, sections Polymérisation et
// Barre (dont le diamètre de la barre).
//
// Filtrage fonctionnel par ligne : rien n'est supprimé en base, les valeurs
// déjà enregistrées restent, simplement plus affichées. PROMESH inchangé.
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
const DAY = "2035-06-12";
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];

const binary = (res, cb) => {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => cb(null, Buffer.from(data, "binary")));
};

const LIGNE = ["VARIATEUR EN FRÉQUENCE DE TIRAGE", "VARIATEUR EN FRÉQUENCE DE BOBINAGE", "VITESSE DE BARRE (m/min)", "NOMBRE DE BOBINES", "ALIGNEMENT DES FIBRES"];
const CHAUFFAGE = ["TEMPÉRATURE ZONE 1", "TEMPÉRATURE ZONE 2", "TEMPÉRATURE ZONE 3", "PRESSION D'AIR", "VISCOSITÉ DE LA RÉSINE", "RATIO RÉSINE / DURCISSEUR / CATALYSEUR"];
// Contrôles retirés des prélèvements PROBAR (clé → libellé).
const REMOVED = {
  niveau_bain_graines: "NIVEAU BAIN DE GRAINES",
  vitesse_tirage_bobinage: "VITESSE DE TIRAGE DE BOBINAGE",
  vitesse_alimentation_fibres: "VITESSE D'ALIMENTATION DES FIBRES",
  vitesse_bobinage: "VITESSE DE BOBINAGE (m/min)",
  temperature_zones_chauffage: "TEMPÉRATURE DES DIFFÉRENTES ZONES DE CHAUFFAGE",
  pression_impregnation: "PRESSION / CONDITIONS D'IMPRÉGNATION",
  vitesse_tirage: "VITESSE DE TIRAGE",
  tension_rovings: "TENSION DES ROVINGS",
  nombre_rovings: "NOMBRE DE ROVINGS",
  temperature_filiere: "TEMPÉRATURE DE LA FILIÈRE",
  temps_gel: "TEMPS DE GEL",
  degre_polymerisation: "DEGRÉ DE POLYMÉRISATION",
  vitesse_polymerisation: "VITESSE DE POLYMÉRISATION",
  diametre_bar: "DIAMÈTRE DE LA BARRE",
  ovalisation: "OVALISATION",
  etat_surface: "ÉTAT DE SURFACE",
  revetement: "QUANTITÉ ET RÉGULARITÉ DU REVÊTEMENT",
};
const REMOVED_KEYS = Object.keys(REMOVED);
// Jamais dans PROBAR non plus : contrôles du treillis GFRP (PROMESH).
const NEVER_PROBAR = ["TOLÉRANCE DIMENSIONNELLE", "ESPACEMENT DES FILS"];
const SECTION_OF = new Map(cfg.parameters.map((p) => [p.key, p.section]));

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

describe("Contrôle Qualité — paramètres PROBAR restructurés", () => {
  let qc;
  let probar;

  const post = (path, body) => request(app).post(path).set(auth(qc)).send(body);
  const put = (path, body) => request(app).put(path).set(auth(qc)).send(body);
  const get = (path) => request(app).get(path).set(auth(qc));
  const sectionItems = (fiche, section) => fiche.readings[0].items.filter((i) => !section || SECTION_OF.get(i.parameterKey) === section);
  const readingLabels = (fiche, section) => sectionItems(fiche, section).map((i) => i.parameterName);
  // Compteur « X / Y contrôlé(s) » d'une catégorie, tel que l'écran le calcule.
  const sectionCount = (fiche, section) => `${sectionItems(fiche, section).filter((i) => i.status !== "NON_CONTROLE").length} / ${sectionItems(fiche, section).length}`;

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

  test("configuration PROBAR : A (5), B (6), ni Polymérisation ni Barre ; listes distinctes par ligne", async () => {
    const { data } = (await get("/quality-control/config")).body;
    const reading = (type, section) => data.parameters.filter((p) => p.scope === "reading" && p.lines.includes(type) && (!section || p.section === section));
    expect(reading("PROBAR", "ligne").map((p) => p.label)).toEqual(LIGNE);
    expect(reading("PROBAR", "chauffage").map((p) => p.label)).toEqual(CHAUFFAGE);
    expect(reading("PROBAR", "polymerisation")).toEqual([]);
    expect(reading("PROBAR", "barre")).toEqual([]);
    // Refroidissement / coupe : plus dans les prélèvements PROBAR (paramètres physiques).
    expect(reading("PROBAR", "coupe")).toEqual([]);
    expect(reading("PROBAR", "machine").map((p) => p.key)).toEqual(["temperature_eau", "fuite_air_comprime", "fuite_eau", "etat_disque_coupe"]);
    expect(reading("PROBAR")).toHaveLength(15);
    expect(cfg.physicalParameters("PROBAR")).toHaveLength(7);
    expect(cfg.physicalParameters("PROBAR").map((p) => p.key)).not.toContain("phys_ovalisation");
    expect(cfg.specificParameters("PROBAR")).toEqual([]);

    // Nouveaux contrôles : champs de saisie numériques, propres à PROBAR.
    const by = Object.fromEntries(data.parameters.map((p) => [p.key, p]));
    for (const key of ["variateur_frequence_tirage", "variateur_frequence_bobinage", "nombre_bobines", "vitesse_barre"]) {
      expect(by[key]).toMatchObject({ kind: "number", scope: "reading", section: "ligne", lines: ["PROBAR"] });
    }
    expect(by.vitesse_barre.label).toBe("VITESSE DE BARRE (m/min)");
    // Plus aucun libellé retiré dans la liste PROBAR.
    const probarLabels = reading("PROBAR").map((p) => p.label);
    for (const label of [...Object.values(REMOVED), ...NEVER_PROBAR]) expect(probarLabels).not.toContain(label);
    // La section « Barre » n'a plus aucun paramètre : elle n'est plus renvoyée.
    expect(data.sections.map((s) => s.key)).toEqual(["controle_machine", "controle_promesh_4", "ligne", "chauffage", "machine", "physique"]);
    expect(data.parameters.every((p) => p.lines.length > 0)).toBe(true);
  });

  test("les contrôles PROBAR ne sont jamais acceptés pour PROMESH (voir qualityControl.promeshStructure.test.js)", async () => {
    const res = await post("/quality-control", { productionType: "PROMESH", machine: "2", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [{ parameterKey: "temperature_machine", value: "20", status: "CONFORME" }] } });
    expect(res.status).toBe(201);
    created.push(res.body.data.id);
    for (const parameterKey of ["variateur_frequence_tirage", "variateur_frequence_bobinage", "nombre_bobines", "vitesse_barre"]) {
      const r = await put(`/quality-control/${res.body.data.id}/readings/${res.body.data.readingId}`, { items: [{ parameterKey, value: "4", status: "CONFORME" }] });
      expect(r.status).toBe(400);
    }
  });

  test("nouveau contrôle PROBAR : nouvelle structure, compteurs par section, sauvegarde et modification", async () => {
    const res = await post("/quality-control", { productionType: "PROBAR", machine: "2", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [] } });
    expect(res.status).toBe(201);
    probar = res.body.data;
    created.push(probar.id);

    expect(readingLabels(probar, "ligne")).toEqual(LIGNE);
    expect(readingLabels(probar, "chauffage")).toEqual(CHAUFFAGE);
    for (const label of [...Object.values(REMOVED), ...NEVER_PROBAR]) expect(readingLabels(probar)).not.toContain(label);
    expect(probar.specificParameters).toEqual([]);
    // Contrôle produit PROBAR : 7 (voir qualityControl.probarPhysical.test.js).
    expect(probar.physicalParameters).toHaveLength(7);
    // Compteurs calculés sur les paramètres actifs (jamais codés en dur).
    expect(sectionCount(probar, "ligne")).toBe("0 / 5");
    expect(sectionCount(probar, "chauffage")).toBe("0 / 6");
    expect(probar.readings[0].counts).toMatchObject({ controlled: 0, total: 15 });

    // Sauvegarde : valeur + statut + remarque sur les nouveaux contrôles.
    const saved = await put(`/quality-control/${probar.id}/readings/${probar.readingId}`, {
      items: [
        { parameterKey: "variateur_frequence_tirage", value: "50", status: "CONFORME" },
        { parameterKey: "variateur_frequence_bobinage", value: "1.2", status: "CONFORME" },
        { parameterKey: "nombre_bobines", value: "24", status: "CONFORME" },
        { parameterKey: "vitesse_barre", value: "3.5", status: "NON_CONFORME", remark: "trop rapide" },
        { parameterKey: "viscosite_resine", value: "450", status: "CONFORME" },
      ],
    });
    expect(saved.status).toBe(200);
    const s = saved.body.data;
    expect(sectionCount(s, "ligne")).toBe("4 / 5");
    expect(sectionCount(s, "chauffage")).toBe("1 / 6");
    expect(s.readings[0].counts).toMatchObject({ controlled: 5, total: 15, nonConformes: 1 });
    expect(s.counts).toMatchObject({ controlled: 5, total: 15, nonConformes: 1 });
    expect(s.readings[0].items.find((i) => i.parameterKey === "vitesse_barre")).toMatchObject({ value: "3.5", status: "NON_CONFORME", remark: "trop rapide" });
    expect(s.nonConformParameters).toEqual(["VITESSE DE BARRE (m/min)"]);

    // Modification (brouillon) : relue depuis la base.
    const edited = await put(`/quality-control/${probar.id}/readings/${probar.readingId}`, { items: [{ parameterKey: "vitesse_barre", value: "2.8", status: "CONFORME", remark: "" }] });
    expect(edited.status).toBe(200);
    const reread = (await get(`/quality-control/${probar.id}`)).body.data;
    expect(reread.readings[0].items.find((i) => i.parameterKey === "vitesse_barre")).toMatchObject({ value: "2.8", status: "CONFORME" });
    expect(reread.readings[0].items.find((i) => i.parameterKey === "nombre_bobines").value).toBe("24");
    expect(reread.counts).toMatchObject({ controlled: 5, nonConformes: 0 });

    // Les contrôles retirés ne sont plus acceptés pour PROBAR : rien n'est écrit.
    for (const parameterKey of REMOVED_KEYS) {
      const r = await put(`/quality-control/${probar.id}/readings/${probar.readingId}`, { items: [{ parameterKey, value: "1", status: "CONFORME" }] });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("UNKNOWN_PARAMETER");
    }
    const stored = await sql(`SELECT "parameterKey" FROM quality_control_items WHERE "qualityControlId" = :id`, { id: probar.id });
    expect(stored.map((i) => i.parameterKey).sort()).toEqual(["nombre_bobines", "variateur_frequence_bobinage", "variateur_frequence_tirage", "viscosite_resine", "vitesse_barre"]);
  });

  test("chauffage : température zone 1, 2 et 3 saisies et enregistrées SÉPARÉMENT ; pression d'air avec valeur, statut et remarque", async () => {
    const res = await post("/quality-control", { productionType: "PROBAR", machine: "4", productionDate: DAY, poste: "soir", reading: { readingTime: "08:00", items: [] } });
    expect(res.status).toBe(201);
    const c = res.body.data;
    created.push(c.id);
    // Nouvelle fiche : champs vides.
    const empty = Object.fromEntries(c.readings[0].items.map((i) => [i.parameterKey, i]));
    for (const key of ["temperature_zone_1", "temperature_zone_2", "temperature_zone_3", "pression_air", "variateur_frequence_bobinage", "vitesse_barre"]) {
      expect(empty[key]).toMatchObject({ value: null, status: "NON_CONTROLE", remark: null });
    }

    const saved = await put(`/quality-control/${c.id}/readings/${c.readingId}`, {
      items: [
        { parameterKey: "temperature_zone_1", value: "180", status: "CONFORME" },
        { parameterKey: "temperature_zone_2", value: "195", status: "CONFORME" },
        { parameterKey: "temperature_zone_3", value: "210", status: "NON_CONFORME", remark: "zone 3 trop chaude" },
        { parameterKey: "pression_air", value: "6.5", status: "CONFORME", remark: "stable" },
        { parameterKey: "variateur_frequence_bobinage", value: "42", status: "CONFORME" },
        { parameterKey: "vitesse_barre", value: "1.8", status: "CONFORME" },
      ],
    });
    expect(saved.status).toBe(200);
    expect(sectionCount(saved.body.data, "chauffage")).toBe("4 / 6");
    expect(sectionCount(saved.body.data, "ligne")).toBe("2 / 5");

    // PostgreSQL : une ligne par zone, jamais une valeur combinée.
    const rows = await sql(`SELECT "parameterKey" k, value, status FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" LIKE 'temperature_zone_%' ORDER BY 1`, { id: c.id });
    expect(rows).toEqual([
      { k: "temperature_zone_1", value: "180", status: "CONFORME" },
      { k: "temperature_zone_2", value: "195", status: "CONFORME" },
      { k: "temperature_zone_3", value: "210", status: "NON_CONFORME" },
    ]);

    // Réouverture : valeurs relues depuis la base ; modification d'UNE zone sans toucher aux autres.
    await put(`/quality-control/${c.id}/readings/${c.readingId}`, { items: [{ parameterKey: "temperature_zone_3", value: "200", status: "CONFORME", remark: "" }] });
    const reread = Object.fromEntries((await get(`/quality-control/${c.id}`)).body.data.readings[0].items.map((i) => [i.parameterKey, i]));
    expect([reread.temperature_zone_1.value, reread.temperature_zone_2.value, reread.temperature_zone_3.value]).toEqual(["180", "195", "200"]);
    expect(reread.temperature_zone_3).toMatchObject({ status: "CONFORME", remark: null });
    expect(reread.pression_air).toMatchObject({ value: "6.5", status: "CONFORME", remark: "stable" });
    expect(reread.vitesse_barre.parameterName).toBe("VITESSE DE BARRE (m/min)");
    // La pression d'air du chauffage est distincte de la pression d'air comprimé (PROMESH uniquement).
    expect(reread.pression_air_comprime).toBeUndefined();
  });

  test("ratio résine / durcisseur / catalyseur : contrôle binaire Conforme / Non conforme, sans valeur saisie ; compteurs et résultat recalculés", async () => {
    const { data } = (await get("/quality-control/config")).body;
    const ratio = data.parameters.find((p) => p.key === "ratio_resine_durcisseur_catalyseur");
    expect(ratio).toMatchObject({ kind: "conformity", section: "chauffage", lines: ["PROBAR"], options: [] });

    const res = await post("/quality-control", { productionType: "PROBAR", machine: "3", productionDate: DAY, poste: "matin", reading: { readingTime: "08:00", items: [] } });
    expect(res.status).toBe(201);
    const c = res.body.data;
    created.push(c.id);
    const item = (fiche) => fiche.readings[0].items.find((i) => i.parameterKey === "ratio_resine_durcisseur_catalyseur");
    expect(item(c)).toMatchObject({ value: null, status: "NON_CONTROLE" });
    const save = (items) => put(`/quality-control/${c.id}/readings/${c.readingId}`, { items });

    // Conforme : le statut seul suffit — la valeur enregistrée suit le statut.
    const ok = await save([{ parameterKey: "ratio_resine_durcisseur_catalyseur", status: "CONFORME" }]);
    expect(ok.status).toBe(200);
    expect(item(ok.body.data)).toMatchObject({ value: "Conforme", status: "CONFORME" });
    expect(sectionCount(ok.body.data, "chauffage")).toBe("1 / 6");
    expect(ok.body.data.readings[0].counts).toMatchObject({ controlled: 1, total: 15, nonConformes: 0 });

    // Une valeur libre envoyée est ignorée : jamais de saisie pour ce paramètre.
    const nc = await save([{ parameterKey: "ratio_resine_durcisseur_catalyseur", value: "100 / 2 / 1", status: "NON_CONFORME", remark: "dosage à revoir" }]);
    expect(nc.status).toBe(200);
    expect(item(nc.body.data)).toMatchObject({ value: "Non conforme", status: "NON_CONFORME", remark: "dosage à revoir" });
    expect(nc.body.data.readings[0].counts).toMatchObject({ controlled: 1, total: 15, nonConformes: 1 });
    expect(await sql(`SELECT value, status FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" = 'ratio_resine_durcisseur_catalyseur'`, { id: c.id })).toEqual([{ value: "Non conforme", status: "NON_CONFORME" }]);

    // Validation : un ratio non conforme impose un prélèvement NON CONFORME.
    const validated = await post(`/quality-control/${c.id}/readings/${c.readingId}/validate`, { status: "CONFORME" });
    expect(validated.status).toBe(200);
    expect(validated.body.data.readings[0]).toMatchObject({ isValidated: true, status: "NON_CONFORME" });
  });

  test("retirés de PROBAR : état d'impression, pression d'air comprimé, température de machine (prélèvement) et ovalisation (physique) — absents et refusés ; PROMESH les garde", async () => {
    const res = await post("/quality-control", { productionType: "PROBAR", machine: "1", productionDate: DAY, poste: "soir", reading: { readingTime: "08:00", items: [] } });
    expect(res.status).toBe(201);
    const c = res.body.data;
    created.push(c.id);
    const keys = c.readings[0].items.map((i) => i.parameterKey);
    for (const key of ["etat_impression", "pression_air_comprime", "temperature_machine"]) {
      expect(keys).not.toContain(key);
      const refused = await put(`/quality-control/${c.id}/readings/${c.readingId}`, { items: [{ parameterKey: key, value: "Conforme", status: "CONFORME" }] });
      expect(refused.status).toBe(400);
      expect(["UNKNOWN_PARAMETER", "INVALID_PAYLOAD"]).toContain(refused.body.code);
    }
    expect(c.physicalParameters.map((p) => p.parameterKey)).not.toContain("phys_ovalisation");
    expect(c.physicalParameters.map((p) => p.parameterKey)).not.toContain("etat_impression");
    expect((await put(`/quality-control/${c.id}`, { physical: [{ parameterKey: "phys_ovalisation", value: "0.2" }] })).status).toBe(400);
    expect(sectionCount(c, "machine")).toBe("0 / 4");
    // PROMESH les garde : pression d'air comprimé (contrôle machine), état d'impression (contrôle produit).
    expect(cfg.readingParametersFor("PROMESH").map((p) => p.key)).toEqual(expect.arrayContaining(["pression_air_comprime", "temperature_machine"]));
    expect(cfg.physicalParameters("PROMESH").map((p) => p.key)).toContain("etat_impression");
  });

  test("ancien contrôle PROBAR : anciennes valeurs conservées en base, plus affichées ni comptées ; validation, statistiques et export sur les paramètres actifs", async () => {
    // Valeurs saisies AVANT la restructuration (écrites directement en base,
    // comme les fiches PROBAR déjà enregistrées).
    const position = (key) => cfg.parameters.find((p) => p.key === key).position;
    const old = [
      ["vitesse_tirage", "20", "CONFORME"],
      ["nombre_rovings", "8", "CONFORME"],
      ["niveau_bain_graines", "Bien", "CONFORME"],
      ["temperature_filiere", "180", "CONFORME"],
      ["temps_gel", "12", "CONFORME"],
      ["ovalisation", "0.4", "NON_CONFORME"],
      ["diametre_bar", "12", "CONFORME"],
    ];
    await QualityControlItem.bulkCreate(
      old.map(([parameterKey, value, status]) => ({ qualityControlId: probar.id, readingId: probar.readingId, parameterKey, parameterName: REMOVED[parameterKey], position: position(parameterKey), value, status }))
    );
    const legacy = () => sql(`SELECT "parameterKey", value, status FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" IN (:keys) ORDER BY 1`, { id: probar.id, keys: REMOVED_KEYS });
    const before = await legacy();
    expect(before).toHaveLength(7);

    // Consultation : la fiche s'ouvre, sans les contrôles retirés, compteurs inchangés.
    const detail = (await get(`/quality-control/${probar.id}`)).body.data;
    for (const label of Object.values(REMOVED)) expect(readingLabels(detail)).not.toContain(label);
    expect(detail.readings[0].items).toHaveLength(15);
    expect(detail.counts).toMatchObject({ controlled: 5, total: 15, nonConformes: 0 });
    expect(detail.nonConformParameters).toEqual([]);
    const listed = (await get(`/quality-control?search=${encodeURIComponent(probar.reference)}`)).body.data.find((c) => c.id === probar.id);
    expect(listed.counts).toMatchObject({ controlled: 5, nonConformes: 0 });

    // Validation : fiche conforme (l'ancienne ovalisation non conforme, masquée, ne compte pas).
    const v = await post(`/quality-control/${probar.id}/validate`, { status: "CONFORME" });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ isValidated: true, status: "CONFORME" });
    // Validée : lecture seule.
    const locked = await put(`/quality-control/${probar.id}/readings/${probar.readingId}`, { items: [{ parameterKey: "nombre_bobines", value: "30", status: "CONFORME" }] });
    expect(locked.status).toBe(403);

    // Rien n'a été supprimé ni modifié : valeurs historiques et journal intacts.
    expect(await legacy()).toEqual(before);
    const [{ n }] = await sql(`SELECT COUNT(*)::int AS n FROM quality_control_history WHERE "qualityControlId" = :id`, { id: probar.id });
    expect(n).toBeGreaterThan(0);

    // Statistiques (comparaison) : uniquement les paramètres PROBAR actifs.
    const opened = detail.controlDate.split("/").reverse().join("-"); // date d'ouverture de la fiche
    const cmp = (await get(`/quality-control/comparison?periodAStart=${opened}&periodAEnd=${opened}&periodBStart=${opened}&periodBEnd=${opened}&productionType=PROBAR&machine=2`)).body.data;
    const cmpKeys = cmp.parameters.map((p) => p.key);
    expect(cmpKeys).toEqual(expect.arrayContaining(["variateur_frequence_tirage", "variateur_frequence_bobinage", "nombre_bobines", "vitesse_barre", "viscosite_resine"]));
    const active = new Set(cfg.readingParametersFor("PROBAR").map((p) => p.key));
    expect(cmpKeys.every((k) => active.has(k))).toBe(true);

    // Export Excel de l'Historique : feuille « Paramètres » sans contrôle retiré.
    const x = await get(`/quality-control/export?format=xlsx&search=${encodeURIComponent(probar.reference)}`).buffer(true).parse(binary);
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    const rows = [];
    wb.getWorksheet("Paramètres").eachRow((r, i) => i > 4 && rows.push(r.values.slice(1)));
    const exported = rows.filter((r) => r[0] === probar.reference).map((r) => r[4]);
    expect(exported.sort()).toEqual(["NOMBRE DE BOBINES", "VARIATEUR EN FRÉQUENCE DE TIRAGE", "VISCOSITÉ DE LA RÉSINE", "VITESSE DE BARRE (m/min)", "VARIATEUR EN FRÉQUENCE DE BOBINAGE"].sort());
    const details = [];
    wb.getWorksheet("Détail des contrôles").eachRow((r) => details.push(r.values.slice(1)));
    expect(details.find((r) => r[4] === probar.reference).slice(10, 13)).toEqual([5, 5, 0]); // contrôlés, conformes, non conformes
  });
});
