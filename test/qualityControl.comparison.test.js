"use strict";

// Module CONTRÔLE QUALITÉ — COMPARAISON QUALITÉ dynamique (période A /
// période B), sur PostgreSQL réel. Tout ce qui est vérifié ici est CALCULÉ à
// partir des fiches créées par le test (aucune valeur par défaut).
//
// Jeu de données dédié en MARS 2034 (aucune donnée réelle sur ces dates) :
//   Période A (01→15/03/2034)
//     a1 PROMESH M1 matin  Non conforme — nombre de bar en longueur NC
//     a2 PROMESH M1 matin  Conforme     — 3 contrôles PROMESH conformes
//     a3 PROMESH M2 soir   Conforme
//     a4 PROBAR  M1 soir   Non conforme — diamètre de la barre NC
//     a5 PROBAR  M1 matin  Conforme
//     a6 PROMESH M2 soir   brouillon (à vérifier)
//   Période B (16→31/03/2034)
//     b1 PROMESH M1 matin  Non conforme — nombre de bar en largeur NC
//     b2 PROMESH M1 matin  Conforme     — 3 contrôles PROMESH conformes
//     b3 PROMESH M2 soir   Conforme
//     b4 PROBAR  M1 soir   Conforme
//     b5 PROBAR  M1 soir   Conforme
//     b6 PROMESH M2 soir   Conforme
//     b7 PROMESH M1 matin  Conforme
// Supprimé en afterAll.

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
const ExcelJS = require("exceljs");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const RUN_ID = Date.now();
const created = [];
const users = [];
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const binary = (res, cb) => {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => cb(null, Buffer.from(data, "binary")));
};

const A = { start: "2034-03-01", end: "2034-03-15" };
const B = { start: "2034-03-16", end: "2034-03-31" };
const periods = (a, b) => `periodAStart=${a.start}&periodAEnd=${a.end}&periodBStart=${b.start}&periodBEnd=${b.end}`;
const BAR_KEYS = ["diametre_bar", "vitesse_barre", "nombre_bobines", "revetement", "nombre_bobines", "vitesse_barre"];
// Contrôles propres à PROMESH (prélèvement) utilisés par le jeu de données.
// Contrôles propres à PROMESH (contrôle machine du prélèvement).
const TREILLIS = { ml: "pression_air_comprime", pf: "niveau_bain_graines", qi: "fuite_eau" };

describe("Contrôle Qualité — comparaison qualité dynamique", () => {
  let qc;
  let admin;
  let prod;
  let qcUserId;

  const get = (extra = "", a = A, b = B, token = qc) => request(app).get(`/quality-control/comparison?${periods(a, b)}${extra}`).set(auth(token));
  const data = async (extra, a, b) => {
    const res = await get(extra, a, b);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  // Crée une fiche (un prélèvement), pose le contrôle treillis éventuel, valide.
  async function make(type, machine, date, poste, { validate = true, items = [], treillis = null } = {}) {
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qc))
      .send({
        productionType: type,
        machine,
        controlDate: date,
        controlTime: "09:30:00",
        productionDate: date,
        poste,
        // PROMESH n'a plus de contrôle de niveau fiche : ses contrôles propres sont des paramètres du prélèvement.
        items: [
          { parameterKey: "temperature_eau", value: "8", status: "CONFORME" },
          // Température de machine : PROMESH uniquement (retirée de PROBAR).
          { parameterKey: type === "PROBAR" ? "viscosite_resine" : "temperature_machine", value: "180", status: "CONFORME" },
          ...items,
          ...Object.entries(treillis || {}).map(([parameterKey, status]) => ({ parameterKey, value: "1", status })),
        ],
      });
    expect(res.status).toBe(201);
    const fiche = res.body.data;
    created.push(fiche.id);
    if (validate) {
      const nc = items.some((i) => i.status === "NON_CONFORME") || Object.values(treillis || {}).includes("NON_CONFORME");
      const v = await request(app).post(`/quality-control/${fiche.id}/validate`).set(auth(qc)).send({ status: nc ? "NON_CONFORME" : "CONFORME" });
      expect(v.status).toBe(200);
    }
    return fiche;
  }

  const ok = (parameterKey) => ({ parameterKey, value: "12", status: "CONFORME" });
  const nok = (parameterKey) => ({ parameterKey, value: "x", status: "NON_CONFORME" });

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
    qcUserId = (await User.findOne({ where: { email: QC_EMAIL } })).id;
    const mk = async (role) => {
      const u = await User.create({ email: `qc-cmp-${role}-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash("StrongPass123!", 12), isActive: true, role });
      users.push(u.id);
      return (await request(app).post("/auth/signin").send({ email: u.email, password: "StrongPass123!" })).body.accessToken;
    };
    admin = await mk("superadmin");
    prod = await mk("responsable_logistique_achat");

    // Période A
    await make("PROMESH", "1", "2034-03-03", "matin", { treillis: { [TREILLIS.ml]: "CONFORME", [TREILLIS.pf]: "CONFORME", [TREILLIS.qi]: "NON_CONFORME" } });
    await make("PROMESH", "1", "2034-03-05", "matin", { treillis: { [TREILLIS.ml]: "CONFORME", [TREILLIS.pf]: "CONFORME", [TREILLIS.qi]: "CONFORME" } });
    await make("PROMESH", "2", "2034-03-07", "soir");
    await make("PROBAR", "1", "2034-03-09", "soir", { items: [nok("nombre_bobines"), ok("vitesse_barre")] });
    await make("PROBAR", "1", "2034-03-11", "matin", { items: [ok("nombre_bobines")] });
    await make("PROMESH", "2", "2034-03-12", "soir", { validate: false });
    // Période B
    await make("PROMESH", "1", "2034-03-18", "matin", { treillis: { [TREILLIS.ml]: "CONFORME", [TREILLIS.pf]: "NON_CONFORME", [TREILLIS.qi]: "CONFORME" } });
    await make("PROMESH", "1", "2034-03-20", "matin", { treillis: { [TREILLIS.ml]: "CONFORME", [TREILLIS.pf]: "CONFORME", [TREILLIS.qi]: "CONFORME" } });
    await make("PROMESH", "2", "2034-03-22", "soir");
    await make("PROBAR", "1", "2034-03-24", "soir", { items: [ok("nombre_bobines"), ok("vitesse_barre")] });
    await make("PROBAR", "1", "2034-03-26", "soir", { items: [ok("nombre_bobines")] });
    await make("PROMESH", "2", "2034-03-27", "soir");
    await make("PROMESH", "1", "2034-03-28", "matin");
  }, 120000);

  afterAll(async () => {
    if (created.length) {
      const r = { replacements: { ids: created } };
      await sequelize.query(`DELETE FROM notifications WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_history WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_items WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_readings WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_controls WHERE id IN (:ids)`, r);
    }
    await User.destroy({ where: { id: users } });
    await sequelize.close();
  }, 30000);

  test("TEST 1 — deux périodes avec données : 12 KPI, variations, séries des graphiques, paramètres", async () => {
    const d = await data();
    expect(d.dataStatus).toBe("ok");
    expect(d.comparable).toBe(true);
    expect(d.messages).toEqual([]);
    expect(d.periodA).toMatchObject({ start: A.start, end: A.end, total: 6, conformes: 3, nonConformes: 2, aVerifier: 1, valides: 5, releves: 6, parametresControles: 21, parametresNonConformes: 2, machinesControlees: 3, tauxConformite: 60, tauxNonConformite: 40, moyenneParametresControles: 3.5, moyenneParametresNonConformes: 0.33 });
    expect(d.periodB).toMatchObject({ total: 7, conformes: 6, nonConformes: 1, aVerifier: 0, valides: 7, releves: 7, parametresControles: 23, parametresNonConformes: 1, machinesControlees: 3, tauxConformite: 85.71, tauxNonConformite: 14.29, moyenneParametresControles: 3.29, moyenneParametresNonConformes: 0.14 });
    // Variations : nombres en valeur + %, taux en POINTS, moyennes en valeur.
    expect(d.evolution.total).toEqual({ absolue: 1, relative: 16.67 });
    expect(d.evolution.nonConformes).toEqual({ absolue: -1, relative: -50 });
    expect(d.evolution.aVerifier).toEqual({ absolue: -1, relative: -100 });
    expect(d.evolution.machinesControlees).toEqual({ absolue: 0, relative: 0 });
    expect(d.evolution.tauxConformite).toEqual({ points: 25.71 });
    expect(d.evolution.tauxNonConformite).toEqual({ points: -25.71 });
    expect(d.evolution.moyenneParametresNonConformes).toEqual({ absolue: -0.19 });
    // Même décompte que l'Historique pour les mêmes dates.
    for (const [p, expected] of [[A, 6], [B, 7]]) {
      const list = await request(app).get(`/quality-control?limit=1&from=${p.start}&to=${p.end}`).set(auth(qc));
      expect(list.body.pagination.total).toBe(expected);
    }
    // Graphique linéaire : un point par jour ayant des contrôles.
    expect(d.daily.periodA.map((x) => x.date)).toEqual(["2034-03-03", "2034-03-05", "2034-03-07", "2034-03-09", "2034-03-11", "2034-03-12"]);
    expect(d.daily.periodA[0]).toMatchObject({ total: 1, conformes: 0, nonConformes: 1, tauxConformite: 0 });
    expect(d.daily.periodA[5]).toMatchObject({ total: 1, valides: 0, tauxConformite: null }); // brouillon : pas de taux
    expect(d.daily.periodB).toHaveLength(7);
    // Évolution des paramètres : conformité par paramètre, en points.
    const param = (type, key) => d.parameters.find((p) => p.type === type && p.key === key);
    expect(param("PROMESH", TREILLIS.qi)).toMatchObject({ group: "releve", sectionLabel: "Contrôle Machine", periodA: { controles: 2, nonConformes: 1, tauxConformite: 50 }, periodB: { controles: 2, nonConformes: 0, tauxConformite: 100 }, evolutionPoints: 50, limited: false });
    expect(param("PROMESH", TREILLIS.pf).evolutionPoints).toBe(-50);
    expect(param("PROMESH", TREILLIS.ml).evolutionPoints).toBe(0);
    expect(param("PROBAR", "nombre_bobines")).toMatchObject({ group: "releve", periodA: { controles: 2, nonConformes: 1 }, evolutionPoints: 50 });
    expect(param("PROBAR", "vitesse_barre")).toMatchObject({ evolutionPoints: 0, limited: true }); // 1 mesure par période
    expect(param("PROMESH", "temperature_eau").periodA.controles).toBe(4);
    expect(param("PROBAR", "temperature_eau").periodA.controles).toBe(2);
    // Uniquement les paramètres réellement contrôlés (64 en configuration).
    expect(d.parameters.map((p) => `${p.type}:${p.key}`).sort()).toEqual(
      ["PROBAR:nombre_bobines", "PROBAR:temperature_eau", "PROBAR:vitesse_barre", "PROBAR:viscosite_resine", "PROMESH:temperature_eau", "PROMESH:temperature_machine", `PROMESH:${TREILLIS.ml}`, `PROMESH:${TREILLIS.pf}`, `PROMESH:${TREILLIS.qi}`].sort()
    );
    // Points d'attention / améliorations : calculés, jamais inventés.
    expect(d.attentionPoints.map((p) => p.key)).toEqual([TREILLIS.pf]);
    expect(d.improvements.map((p) => `${p.type}:${p.key}`)).toEqual([`PROMESH:${TREILLIS.qi}`, "PROBAR:nombre_bobines"]);
    // Analyse : phrases construites sur ces chiffres.
    expect(d.analysis).toEqual(
      expect.arrayContaining([
        "Le nombre de contrôles qualité est passé de 6 à 7 (+16,7 %).",
        "Le taux de conformité est passé de 60,0 % à 85,7 % entre les deux périodes, soit une amélioration de 25,7 points.",
        "Principal point d'attention : NIVEAU BAIN DE GRAINES (100,0 % → 50,0 %, −50,0 points).",
      ])
    );
    expect(d.controleur).toBe(QC_EMAIL);
    expect(JSON.stringify(d)).not.toMatch(/NaN|Infinity/);
  });

  test("TEST 2 — période A sans données : message, aucune division par zéro, aucune variation fictive", async () => {
    const empty = { start: "2033-01-01", end: "2033-01-31" };
    const d = await data("", empty, B);
    expect(d.dataStatus).toBe("insufficient");
    expect(d.comparable).toBe(false);
    expect(d.messages.map((m) => m.text)).toEqual(["Aucune donnée disponible pour la période A", "Comparaison impossible : données insuffisantes"]);
    expect(d.periodA).toMatchObject({ total: 0, conformes: 0, tauxConformite: null, tauxNonConformite: null, moyenneParametresControles: null, moyenneParametresNonConformes: null, dataLevel: "none" });
    expect(d.periodB.total).toBe(7);
    // Aucune variation (ni +7, ni +100 %, ni points).
    for (const e of Object.values(d.evolution)) expect(Object.values(e).every((v) => v === null)).toBe(true);
    expect(d.improvements).toEqual([]);
    expect(d.attentionPoints).toEqual([]);
    expect(d.parameters.every((p) => p.evolutionPoints === null)).toBe(true);
    expect(d.analysis).toEqual(["Comparaison impossible : données insuffisantes (aucun contrôle qualité sur la période A)."]);
    expect(JSON.stringify(d)).not.toMatch(/NaN|Infinity/);

    // Période B vide ; puis les deux vides.
    const noB = await data("", A, empty);
    expect(noB.messages.map((m) => m.code)).toEqual(["NO_DATA_B", "INSUFFICIENT"]);
    const none = await data("", empty, { start: "2033-02-01", end: "2033-02-28" });
    expect(none.dataStatus).toBe("empty");
    expect(none.messages[0].text).toBe("Pas suffisamment de données pour cette analyse");
    expect(none.parameters).toEqual([]);
    expect(none.ranking).toBeNull();

    // Un seul contrôle sur A : chiffres donnés, signalés « Données limitées ».
    const limited = await data("", { start: "2034-03-12", end: "2034-03-12" }, B);
    expect(limited.dataStatus).toBe("limited");
    expect(limited.periodA).toMatchObject({ total: 1, dataLevel: "limited" });
    expect(limited.messages.map((m) => m.code)).toEqual(["LIMITED_A"]);
    expect(limited.analysis[0]).toMatch(/^Données limitées/);
  });

  test("TEST 3 — PROMESH : uniquement PROMESH, ses contrôles propres disponibles, aucun paramètre PROBAR", async () => {
    const d = await data("&productionType=PROMESH");
    expect([d.periodA.total, d.periodB.total]).toEqual([4, 5]);
    expect(d.byType.map((t) => t.type)).toEqual(["PROMESH"]);
    expect(d.byMachine.every((m) => m.type === "PROMESH")).toBe(true);
    expect(d.parameters.every((p) => p.type === "PROMESH")).toBe(true);
    const treillis = d.parameters.filter((p) => Object.values(TREILLIS).includes(p.key));
    expect(d.parameters.every((p) => p.group === "releve")).toBe(true); // PROMESH : uniquement des contrôles de prélèvement
    expect(treillis.map((p) => p.key).sort()).toEqual(Object.values(TREILLIS).sort());
    expect(treillis.map((p) => p.sectionLabel).sort()).toEqual(["Contrôle Machine", "Contrôle Machine", "Contrôle Machine"]);
    for (const key of BAR_KEYS) expect(d.parameters.map((p) => p.key)).not.toContain(key);
    expect(d.improvements.map((p) => p.key)).toEqual([TREILLIS.qi]);
  });

  test("TEST 4 — PROBAR : uniquement PROBAR, ses paramètres, aucun paramètre treillis GFRP", async () => {
    const d = await data("&productionType=PROBAR");
    expect([d.periodA.total, d.periodB.total]).toEqual([2, 2]);
    expect(d.periodA.tauxConformite).toBe(50);
    expect(d.periodB.tauxConformite).toBe(100);
    expect(d.byType.map((t) => t.type)).toEqual(["PROBAR"]);
    expect(d.parameters.every((p) => p.type === "PROBAR")).toBe(true);
    expect(d.parameters.map((p) => p.key)).toEqual(expect.arrayContaining(["nombre_bobines", "vitesse_barre"]));
    expect(d.parameters.some((p) => p.key.startsWith("treillis_") || p.group === "treillis")).toBe(false);
    expect(d.attentionPoints).toEqual([]);
  });

  test("TEST 5 — Machine 1 : uniquement Machine 1 (évolution, pas de classement) ; toutes machines : classement", async () => {
    const m1 = await data("&productionType=PROMESH&machine=1");
    expect([m1.periodA.total, m1.periodB.total]).toEqual([2, 3]);
    expect(m1.byMachine.map((m) => `${m.type}:${m.machine}`)).toEqual(["PROMESH:1"]);
    expect(m1.ranking).toBeNull();
    expect(m1.byMachine[0].evolution.tauxConformite.points).toBe(16.67); // 50 % → 66,67 %
    // machineId (nom de l'énoncé) accepté ; machine 1 des deux lignes.
    const both = await data("&machineId=1");
    expect(both.byMachine.map((m) => `${m.type}:${m.machine}`)).toEqual(["PROMESH:1", "PROBAR:1"]);
    expect([both.periodA.total, both.periodB.total]).toEqual([4, 5]);

    const all = await data();
    expect(all.byMachine).toHaveLength(8);
    expect(all.ranking.machines.map((m) => [m.label, m.tauxConformite])).toEqual([
      ["PROMESH · Machine 2", 100],
      ["PROBAR · Machine 1", 100],
      ["PROMESH · Machine 1", 66.67],
    ]);
    expect(all.ranking.best.label).toBe("PROMESH · Machine 2");
    expect(all.ranking.worst.label).toBe("PROMESH · Machine 1");
    // Machine inconnue de la ligne → 400.
    expect((await get("&productionType=PROBAR&machine=9")).status).toBe(400);
  });

  test("TEST 6 — Matin / Soir : données réellement filtrées par poste + phrase calculée", async () => {
    const d = await data();
    const shift = (p) => d.byShift.find((s) => s.poste === p);
    expect(shift("matin").periodA).toMatchObject({ total: 3, valides: 3, nonConformes: 1, tauxNonConformite: 33.33 });
    expect(shift("matin").periodB).toMatchObject({ total: 3, nonConformes: 1, tauxNonConformite: 33.33 });
    expect(shift("soir").periodA).toMatchObject({ total: 3, valides: 2, nonConformes: 1, aVerifier: 1, tauxNonConformite: 50 });
    expect(shift("soir").periodB).toMatchObject({ total: 4, nonConformes: 0, tauxNonConformite: 0 });
    expect(d.shiftInsight).toBe("Le poste Matin présente un taux de non-conformité supérieur de 33,3 points au poste Soir sur la période B.");

    const matin = await data("&poste=matin");
    expect([matin.periodA.total, matin.periodB.total]).toEqual([3, 3]);
    expect(matin.byShift.find((s) => s.poste === "soir").periodA.total).toBe(0);
    const soir = await data("&shift=soir"); // nom de l'énoncé accepté
    expect([soir.periodA.total, soir.periodB.total]).toEqual([3, 4]);
    expect(soir.periodB.tauxConformite).toBe(100);
    expect(soir.shiftInsight).toBeNull(); // un seul poste : aucune phrase
    expect((await get("&poste=apresmidi")).status).toBe(400);
  });

  test("filtres Résultat et Contrôleur ; options tirées de la configuration et des données ; droits", async () => {
    const nc = await data("&result=NON_CONFORME");
    expect(nc.periodA).toMatchObject({ total: 2, conformes: 0, nonConformes: 2, aVerifier: 0 });
    const draft = await data("&result=A_VERIFIER");
    expect(draft.periodA).toMatchObject({ total: 1, aVerifier: 1, tauxConformite: null });
    expect((await data("&result=BROUILLON")).periodA.total).toBe(1); // brouillon = à vérifier
    expect((await get("&result=XYZ")).status).toBe(400);

    const d = await data();
    expect(d.options.lines.map((l) => [l.type, l.machines])).toEqual([["PROMESH", ["1", "2", "3", "4"]], ["PROBAR", ["1", "2", "3", "4"]]]);
    expect(d.options.controllers).toContainEqual({ id: qcUserId, email: QC_EMAIL, label: "Contrôle Qualité" });
    // Admin : tous les comptes Contrôle Qualité, ou celui du filtre.
    const forAdmin = (await get(`&controllerId=${qcUserId}`, A, B, admin)).body.data;
    expect([forAdmin.periodA.total, forAdmin.periodB.total]).toEqual([6, 7]);
    expect(forAdmin.controleur).toBe(QC_EMAIL);
    const other = (await get(`&controllerId=${users[0]}`, A, B, admin)).body.data;
    expect(other.dataStatus).toBe("empty");
    expect((await get("&controllerId=abc")).status).toBe(400);

    expect((await get("", A, B, prod)).status).toBe(403);
    expect((await request(app).get("/quality-control/comparison?periodAStart=2034-03-01").set(auth(qc))).status).toBe(400);
    expect((await get("", { start: "2034-03-10", end: "2034-03-01" }, B)).status).toBe(400);
  });

  test("TEST 9 — export Excel : 7 feuilles, périodes, filtres et comparaison identiques à l'API", async () => {
    const q = "&productionType=PROMESH&poste=matin";
    const d = await data(q);
    const x = await request(app).get(`/quality-control/comparison/export?format=xlsx&${periods(A, B)}${q}`).set(auth(qc)).buffer(true).parse(binary);
    expect(x.status).toBe(200);
    expect(x.headers["content-type"]).toContain("spreadsheetml");
    expect(x.headers["content-disposition"]).toContain("Comparaison_Qualite_2034-03-01_2034-03-31.xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Synthèse", "Période A", "Période B", "Comparaison", "Par machine", "Par paramètre", "Points d'attention"]);
    const rows = (name) => {
      const out = [];
      wb.getWorksheet(name).eachRow((r) => out.push(r.values.slice(1)));
      return out;
    };
    const find = (name, first) => rows(name).find((v) => v[0] === first);

    // Périodes et filtres exacts.
    expect(find("Synthèse", "Période A")[1]).toBe("01/03/2034 → 15/03/2034");
    expect(find("Synthèse", "Période B")[1]).toBe("16/03/2034 → 31/03/2034");
    expect(find("Synthèse", "Ligne")[1]).toBe("PROMESH");
    expect(find("Synthèse", "Machine")[1]).toBe("Toutes");
    expect(find("Synthèse", "Poste")[1]).toBe("Matin");
    expect(find("Synthèse", "Contrôleur")[1]).toBe("Contrôle Qualité");
    expect(find("Synthèse", "Résultat")[1]).toBe("Tous");
    for (const line of d.analysis) expect(rows("Synthèse").some((v) => v[0] === line)).toBe(true);

    // Données exactes : chaque période, puis la comparaison.
    expect(find("Période A", "Contrôles")[1]).toBe(d.periodA.total);
    expect(find("Période A", "Taux de conformité")[1]).toBeCloseTo(d.periodA.tauxConformite / 100);
    expect(find("Période B", "Contrôles")[1]).toBe(d.periodB.total);
    expect(find("Période B", "Paramètres contrôlés")[1]).toBe(d.periodB.parametresControles);
    expect(d.periodA.total).toBe(2);
    expect(find("Comparaison", "Contrôles").slice(1, 4)).toEqual([2, 3, "+1 (+50,0 %)"]);
    expect(find("Comparaison", "Taux de conformité")[3]).toBe("+16,7 pt"); // points, pas %
    expect(find("Comparaison", "Machines contrôlées").slice(1, 3)).toEqual([1, 1]);
    // Une seule ligne filtrée : pas de bloc PROMESH / PROBAR.
    expect(rows("Comparaison").some((v) => String(v[0]).startsWith("PROBAR"))).toBe(false);

    const machines = rows("Par machine").filter((v) => String(v[0]).includes("Machine "));
    expect(machines.filter((v) => /^PROMESH · Machine \d$/.test(v[0])).map((v) => v[0])).toEqual(d.byMachine.map((m) => m.label));
    const params = rows("Par paramètre").filter((v) => v[0] === "PROMESH" || v[0] === "PROBAR");
    expect(params.map((v) => v[2])).toEqual(d.parameters.map((p) => p.label));
    expect(params.every((v) => v[0] === "PROMESH")).toBe(true);
    const attention = rows("Points d'attention");
    expect(attention.find((v) => v[1] === "NIVEAU BAIN DE GRAINES").slice(2, 5)).toEqual([1, 0.5, "-50,0 pt"]);
    expect(attention.find((v) => v[1] === "FUITE D'EAU")[4]).toBe("+50,0 pt");

    // Toutes lignes : bloc PROMESH / PROBAR limité aux indicateurs communs.
    const all = new ExcelJS.Workbook();
    await all.xlsx.load((await request(app).get(`/quality-control/comparison/export?format=xlsx&${periods(A, B)}`).set(auth(qc)).buffer(true).parse(binary)).body);
    const cmpRows = [];
    all.getWorksheet("Comparaison").eachRow((r) => cmpRows.push(r.values.slice(1)));
    expect(cmpRows.find((v) => v[0] === "PROBAR — Contrôles").slice(1, 3)).toEqual([2, 2]);
    expect(cmpRows.find((v) => v[0] === "PROMESH — Taux de conformité")[3]).toBe("+13,3 pt");
    expect(cmpRows.find((v) => v[0] === "Soir — Contrôles").slice(1, 3)).toEqual([3, 4]);
  });

  test("TEST 10 — export PDF : document valide (KPI, graphiques, analyse) ; période vide sans plantage ni graphique", async () => {
    const pdf = async (a, b) => {
      const p = await request(app).get(`/quality-control/comparison/export?format=pdf&${periods(a, b)}`).set(auth(qc)).buffer(true).parse(binary);
      expect(p.status).toBe(200);
      expect(p.headers["content-type"]).toContain("application/pdf");
      const text = p.body.toString("latin1");
      expect(text.startsWith("%PDF-")).toBe(true);
      return { text, size: p.body.length, pages: (text.match(/\/Type \/Page\b/g) || []).length, headers: p.headers };
    };
    const full = await pdf(A, B);
    expect(full.headers["content-disposition"]).toContain("Comparaison_Qualite_2034-03-01_2034-03-31.pdf");
    expect(full.pages).toBeGreaterThanOrEqual(2);
    // Sans données : pas de graphique dessiné → document plus léger.
    const empty = await pdf({ start: "2033-01-01", end: "2033-01-31" }, { start: "2033-02-01", end: "2033-02-28" });
    expect(empty.size).toBeLessThan(full.size);
    expect((await request(app).get(`/quality-control/comparison/export?format=docx&${periods(A, B)}`).set(auth(qc))).status).toBe(400);
  });

  test("TEST 7 — nouveau contrôle créé puis validé : les KPI de la comparaison sont à jour (aucun cache)", async () => {
    const before = await data();
    const fiche = await make("PROMESH", "3", "2034-03-29", "matin", { validate: false });
    const draft = await data();
    expect(draft.periodB.total).toBe(before.periodB.total + 1);
    expect(draft.periodB.aVerifier).toBe(before.periodB.aVerifier + 1);
    expect(draft.periodB.conformes).toBe(before.periodB.conformes);
    expect(draft.periodB.machinesControlees).toBe(before.periodB.machinesControlees + 1);
    expect(draft.periodA.total).toBe(before.periodA.total);

    expect((await request(app).post(`/quality-control/${fiche.id}/validate`).set(auth(qc)).send({ status: "CONFORME" })).status).toBe(200);
    const after = await data();
    expect(after.periodB).toMatchObject({ total: 8, conformes: 7, aVerifier: 0, valides: 8, tauxConformite: 87.5 });
    expect(after.byMachine.find((m) => m.type === "PROMESH" && m.machine === "3").periodB).toMatchObject({ total: 1, tauxConformite: 100 });
  });

  test("TEST 8 — contrôle modifié : statistiques et paramètres recalculés", async () => {
    const fiche = await make("PROBAR", "2", "2034-03-30", "soir", { validate: false, items: [ok("nombre_bobines")] });
    const before = await data("&productionType=PROBAR");
    expect(before.parameters.find((p) => p.key === "nombre_bobines").periodB).toMatchObject({ controles: 3, nonConformes: 0, tauxConformite: 100 });

    const put = await request(app)
      .put(`/quality-control/${fiche.id}/readings/${fiche.readingId}`)
      .set(auth(qc))
      .send({ items: [nok("nombre_bobines"), nok("vitesse_barre")] });
    expect(put.status).toBe(200);
    const after = await data("&productionType=PROBAR");
    expect(after.periodB.parametresNonConformes).toBe(before.periodB.parametresNonConformes + 2);
    expect(after.periodB.parametresControles).toBe(before.periodB.parametresControles + 1);
    expect(after.parameters.find((p) => p.key === "nombre_bobines")).toMatchObject({ periodB: { controles: 3, nonConformes: 1, tauxConformite: 66.67 }, evolutionPoints: 16.67 });
    // L'ovalisation passe en point d'attention (100 % → 50 %).
    expect(after.attentionPoints.map((p) => p.key)).toEqual(["vitesse_barre"]);

    // Validation : la fiche devient non conforme, le taux suit.
    expect((await request(app).post(`/quality-control/${fiche.id}/validate`).set(auth(qc)).send({ status: "NON_CONFORME" })).status).toBe(200);
    const validated = await data("&productionType=PROBAR");
    expect(validated.periodB).toMatchObject({ total: 3, nonConformes: 1, valides: 3, tauxConformite: 66.67 });
    // Suppression logique d'un brouillon : il sort des statistiques.
    const tmp = await make("PROBAR", "3", "2034-03-31", "matin", { validate: false });
    expect((await data("&productionType=PROBAR")).periodB.total).toBe(4);
    expect((await request(app).delete(`/quality-control/${tmp.id}`).set(auth(qc))).status).toBe(200);
    expect((await data("&productionType=PROBAR")).periodB.total).toBe(3);
  });
});
