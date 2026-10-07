"use strict";

// Module CONTRÔLE QUALITÉ — export de l'Historique (xlsx / pdf / csv) et
// Comparaison qualité (période A / période B), sur PostgreSQL réel.
//
// Jeu de données dédié en MARS 2025 (aucune donnée réelle sur ces dates) :
//   Période A (01→15/03/2025) : PROMESH M1 Conforme, PROMESH M1 Non conforme
//     (2 paramètres NC), PROMESH M2 brouillon, PROBAR M1 Conforme.
//   Période B (16→31/03/2025) : PROMESH M1 Conforme ×2, PROBAR M1 Non
//     conforme (1 paramètre NC).
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
const files = require("../src/modules/quality-control/services/qualityControlExport");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const RUN_ID = Date.now();
const created = [];
const users = [];
const auth = (t) => ({ Authorization: `Bearer ${t}` });

// Réponse binaire (xlsx / pdf) → Buffer.
const binary = (res, cb) => {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => cb(null, Buffer.from(data, "binary")));
};

const A = { start: "2025-03-01", end: "2025-03-15" };
const B = { start: "2025-03-16", end: "2025-03-31" };
const range = `from=${A.start}&to=${B.end}`;
const cmp = (extra = "") => `/quality-control/comparison?periodAStart=${A.start}&periodAEnd=${A.end}&periodBStart=${B.start}&periodBEnd=${B.end}${extra}`;

describe("Contrôle Qualité — export Historique et comparaison", () => {
  let qc;
  let admin;
  let prod;

  async function make(type, machine, date, { validate = true, status = "CONFORME", nc = [] } = {}) {
    const items = [
      { parameterKey: "temperature_eau", value: "8", status: "CONFORME" },
      // Température de machine : PROMESH uniquement (retirée de PROBAR).
          { parameterKey: type === "PROBAR" ? "viscosite_resine" : "temperature_machine", value: "180", status: "CONFORME" },
      ...nc.map((k) => ({ parameterKey: k, value: "x", status: "NON_CONFORME" })),
    ];
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qc))
      .send({ productionType: type, machine, controlDate: date, controlTime: "09:30:00", productionDate: date, poste: "matin", items, ...(validate ? { validate: true, status } : {}) });
    expect(res.status).toBe(201);
    created.push(res.body.data.id);
    return res.body.data;
  }

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
    const mk = async (role) => {
      const u = await User.create({ email: `qc-rep-${role}-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash("StrongPass123!", 12), isActive: true, role });
      users.push(u.id);
      return (await request(app).post("/auth/signin").send({ email: u.email, password: "StrongPass123!" })).body.accessToken;
    };
    admin = await mk("superadmin");
    prod = await mk("responsable_logistique_achat");

    // Période A
    await make("PROMESH", "1", "2025-03-05");
    await make("PROMESH", "1", "2025-03-10", { nc: ["pression_air_comprime", "fuite_eau"] });
    await make("PROMESH", "2", "2025-03-12", { validate: false });
    await make("PROBAR", "1", "2025-03-08");
    // Période B
    await make("PROMESH", "1", "2025-03-20");
    await make("PROMESH", "1", "2025-03-25");
    await make("PROBAR", "1", "2025-03-22", { nc: ["fuite_eau"] });
  }, 60000);

  afterAll(async () => {
    if (created.length) {
      const r = { replacements: { ids: created } };
      await sequelize.query(`DELETE FROM notifications WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_history WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_items WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_controls WHERE id IN (:ids)`, r);
    }
    await User.destroy({ where: { id: users } });
    await sequelize.close();
  });

  // ── EXPORT ─────────────────────────────────────────────────────────────

  test("TEST 1 — Excel : PROMESH + Machine 1 + mars 2025 → uniquement les données filtrées, KPI et mise en forme", async () => {
    const q = `productionType=PROMESH&machine=1&${range}`;
    const res = await request(app).get(`/quality-control/export?format=xlsx&${q}`).set(auth(qc)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain("Rapport_Controle_Qualite_PROMESH_Machine1_2025-03-01_2025-03-31.xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Synthèse", "Détail des contrôles", "Paramètres", "Contrôle produit", "Analyse par machine"]);

    // Même filtre que l'Historique → même nombre de lignes.
    const list = await request(app).get(`/quality-control?limit=100&${q}`).set(auth(qc));
    expect(list.body.pagination.total).toBe(4);
    const detail = wb.getWorksheet("Détail des contrôles");
    const rows = [];
    detail.eachRow((r, n) => n > 4 && rows.push(r.values));
    expect(rows).toHaveLength(4);
    expect(rows.every((v) => v[3] === "PROMESH" && v[4] === "Machine 1")).toBe(true);
    expect(rows.map((v) => v[5]).sort()).toEqual(list.body.data.map((c) => c.reference).sort());
    expect(rows[0][1]).toBeInstanceOf(Date); // vraie date Excel (format DD/MM/YYYY)
    expect(detail.getCell("A5").numFmt).toBe("dd/mm/yyyy");
    expect(detail.views[0]).toMatchObject({ state: "frozen", ySplit: 4 }); // lignes figées
    expect(detail.autoFilter).toBeTruthy(); // filtres Excel
    expect(detail.pageSetup).toMatchObject({ paperSize: 9, orientation: "landscape" });

    // Synthèse : KPI (3 conformes, 1 non conforme, 0 à vérifier → 75 %).
    const s1 = wb.getWorksheet("Synthèse");
    const cells = [];
    s1.eachRow((r) => r.eachCell((c) => cells.push(c.value)));
    expect(s1.getCell("A1").value).toBe("RAPPORT DE CONTRÔLE QUALITÉ");
    expect(cells).toEqual(expect.arrayContaining(["CBI Tunisia", "PROMESH", "Machine 1", QC_EMAIL, "TOTAL CONTRÔLES", "TAUX DE CONFORMITÉ"]));
    const kpi = (label) => {
      let value;
      s1.eachRow((r, n) => r.eachCell((c, col) => c.value === label && (value = s1.getCell(n + 1, col).value)));
      return value;
    };
    expect(kpi("TOTAL CONTRÔLES")).toBe(4);
    expect(kpi("CONFORMES")).toBe(3);
    expect(kpi("NON CONFORMES")).toBe(1);
    expect(kpi("À VÉRIFIER")).toBe(0);
    expect(kpi("TAUX DE CONFORMITÉ")).toBeCloseTo(0.75);
    expect(kpi("TAUX DE NON-CONFORMITÉ")).toBeCloseTo(0.25);

    // Paramètres contrôlés : 2 par fiche + 2 NC sur la fiche non conforme.
    const params = [];
    wb.getWorksheet("Paramètres").eachRow((r, n) => n > 4 && params.push(r.values));
    expect(params).toHaveLength(10);
    expect(params.filter((v) => v[7] === "Non conforme")).toHaveLength(2);
    expect(params.every((v) => /^\d{2}:\d{2}$/.test(v[4]))).toBe(true); // heure du prélèvement
    // Analyse par machine : seulement PROMESH · Machine 1.
    const machines = [];
    wb.getWorksheet("Analyse par machine").eachRow((r, n) => n > 4 && machines.push(r.values));
    expect(machines).toHaveLength(1);
    expect(machines[0].slice(1, 6)).toEqual(["PROMESH · Machine 1", 4, 3, 1, 0]);
  });

  test("TEST 2 — PDF A4 : même filtre, titre, KPI, détail paginé", async () => {
    const res = await request(app).get(`/quality-control/export?format=pdf&productionType=PROMESH&machine=1&${range}`).set(auth(qc)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    const raw = res.body.toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/); // A4
    expect((raw.match(/\/Type \/Page\b/g) || []).length).toBeGreaterThanOrEqual(2); // synthèse + détail
  });

  test("PDF : pagination automatique sur un gros volume (en-tête répété, pages numérotées)", async () => {
    const controls = Array.from({ length: 150 }, (_, i) => ({
      reference: `QC-2025-${String(i + 1).padStart(5, "0")}`,
      productionType: i % 2 ? "PROBAR" : "PROMESH",
      machineLabel: `Machine ${(i % 4) + 1}`,
      controlDate: "05/03/2025",
      controlTime: "09:30:00",
      poste: "matin",
      isValidated: true,
      status: i % 3 ? "CONFORME" : "NON_CONFORME",
      counts: { controlled: 5, conformes: 4, nonConformes: 1 },
      controllerEmail: QC_EMAIL,
      items: [],
    }));
    const pdf = await files.buildHistoryPdf({
      filters: {},
      controls,
      summary: { totals: { total: 150, conformes: 100, nonConformes: 50, aVerifier: 0, tauxConformite: 66.67, tauxNonConformite: 33.33 }, byMachine: [] },
      actor: { role: "controle_qualite", email: QC_EMAIL },
      generatedAt: new Date(),
    });
    const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
    expect(pages).toBeGreaterThanOrEqual(4); // 1 synthèse + ≥ 3 pages de détail
  });

  test("CSV : séparateur ; + BOM UTF-8, mêmes lignes filtrées", async () => {
    const res = await request(app).get(`/quality-control/export?format=csv&productionType=PROBAR&${range}`).set(auth(qc)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = res.body.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toContain("Référence contrôle;Poste;Statut;Résultat");
    expect(lines).toHaveLength(3); // en-tête + 2 fiches PROBAR
    expect(lines.slice(1).every((l) => l.includes(";PROBAR;"))).toBe(true);
  });

  test("export : format invalide 400, filtres de dates invalides 400, compte de production 403, admin 200", async () => {
    expect((await request(app).get("/quality-control/export?format=docx").set(auth(qc))).status).toBe(400);
    expect((await request(app).get("/quality-control/export?format=xlsx&from=2025-13-01").set(auth(qc))).status).toBe(400);
    expect((await request(app).get(`/quality-control/export?format=xlsx&from=2025-03-31&to=2025-03-01`).set(auth(qc))).status).toBe(400);
    expect((await request(app).get(`/quality-control/export?format=xlsx&${range}`).set(auth(prod))).status).toBe(403);
    expect((await request(app).get(`/quality-control/export?format=csv&${range}`).set(auth(admin)).buffer(true).parse(binary)).status).toBe(200);
  });

  // ── COMPARAISON ────────────────────────────────────────────────────────

  test("TEST 3 — comparaison A / B : totaux, statuts, taux, évolutions (et cohérence avec l'Historique)", async () => {
    const res = await request(app).get(cmp()).set(auth(qc));
    expect(res.status).toBe(200);
    const { periodA: a, periodB: b, evolution: e } = res.body.data;
    expect(a).toMatchObject({ start: A.start, end: A.end, total: 4, conformes: 2, nonConformes: 1, aVerifier: 1, valides: 3, parametresControles: 10, parametresNonConformes: 2 });
    expect(a.tauxConformite).toBeCloseTo(66.67);
    expect(a.tauxNonConformite).toBeCloseTo(33.33);
    expect(a.moyenneParametresNonConformes).toBe(0.5);
    expect(b).toMatchObject({ total: 3, conformes: 2, nonConformes: 1, aVerifier: 0, valides: 3, parametresNonConformes: 1 });
    expect(e.total).toEqual({ absolue: -1, relative: -25 });
    expect(e.aVerifier).toEqual({ absolue: -1, relative: -100 });
    expect(e.tauxConformite.points).toBe(0); // taux en POINTS
    // Même règle que l'Historique : même nombre pour les mêmes filtres.
    for (const [p, expected] of [[A, a.total], [B, b.total]]) {
      const list = await request(app).get(`/quality-control?limit=1&from=${p.start}&to=${p.end}`).set(auth(qc));
      expect(list.body.pagination.total).toBe(expected);
    }
    // Paramètres : classement dynamique des non-conformités.
    const params = res.body.data.byParameter;
    expect(params[0]).toMatchObject({ key: "fuite_eau", periodA: 1, periodB: 1, total: 2 });
    expect(params.find((p) => p.key === "pression_air_comprime")).toMatchObject({ periodA: 1, periodB: 0, total: 1 });
    expect(params.map((p) => p.total)).toEqual([...params.map((p) => p.total)].sort((x, y) => y - x));
    // Par ligne / par machine.
    const promesh = res.body.data.byType.find((t) => t.type === "PROMESH");
    expect(promesh.periodA).toMatchObject({ total: 3, conformes: 1, nonConformes: 1, aVerifier: 1 });
    expect(promesh.periodB).toMatchObject({ total: 2, conformes: 2 });
    const m1 = res.body.data.byMachine.find((m) => m.type === "PROMESH" && m.machine === "1");
    expect(m1.periodA.total).toBe(2);
    expect(m1.periodB.total).toBe(2);
    expect(m1.evolution.total).toEqual({ absolue: 0, relative: 0 });
    expect(m1.evolution.tauxConformite.points).toBe(50);
    expect(res.body.data.controleur).toBe(QC_EMAIL);
  });

  test("TEST 4/5 — filtres machine et ligne appliqués aux DEUX périodes", async () => {
    const m1 = (await request(app).get(cmp("&productionType=PROMESH&machine=1")).set(auth(qc))).body.data;
    expect([m1.periodA.total, m1.periodB.total]).toEqual([2, 2]);
    expect(m1.byMachine.map((m) => `${m.type}:${m.machine}`)).toEqual(["PROMESH:1"]);
    const probar = (await request(app).get(cmp("&productionType=PROBAR")).set(auth(qc))).body.data;
    expect([probar.periodA.total, probar.periodB.total]).toEqual([1, 1]);
    expect(probar.periodA.tauxConformite).toBe(100);
    expect(probar.periodB.tauxNonConformite).toBe(100);
    expect(probar.byType.map((t) => t.type)).toEqual(["PROBAR"]);
    const promesh = (await request(app).get(cmp("&productionType=PROMESH")).set(auth(qc))).body.data;
    expect(promesh.periodA.total).not.toBe(probar.periodA.total); // résultats différents selon la ligne
  });

  test("TEST 6 — période sans contrôle : 0 / null, jamais NaN ni Infinity", async () => {
    const res = await request(app)
      .get("/quality-control/comparison?periodAStart=2024-01-01&periodAEnd=2024-01-31&periodBStart=2025-03-16&periodBEnd=2025-03-31")
      .set(auth(qc));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/NaN|Infinity/);
    const { periodA: a, evolution: e } = res.body.data;
    expect(a).toMatchObject({ total: 0, conformes: 0, tauxConformite: null, tauxNonConformite: null, moyenneParametresNonConformes: null });
    expect(e.total).toEqual({ absolue: null, relative: null }); // période vide → aucune variation
    expect(e.tauxConformite.points).toBeNull();
    // Export de cette comparaison : aucun plantage.
    const pdf = await request(app)
      .get("/quality-control/comparison/export?format=pdf&periodAStart=2024-01-01&periodAEnd=2024-01-31&periodBStart=2024-02-01&periodBEnd=2024-02-29")
      .set(auth(qc))
      .buffer(true)
      .parse(binary);
    expect(pdf.status).toBe(200);
  });

  test("comparaison : dates manquantes / invalides / inversées → 400 ; compte de production → 403", async () => {
    expect((await request(app).get("/quality-control/comparison?periodAStart=2025-03-01").set(auth(qc))).status).toBe(400);
    expect((await request(app).get("/quality-control/comparison?periodAStart=2025-02-30&periodAEnd=2025-03-01&periodBStart=2025-03-02&periodBEnd=2025-03-03").set(auth(qc))).status).toBe(400);
    expect((await request(app).get("/quality-control/comparison?periodAStart=2025-03-10&periodAEnd=2025-03-01&periodBStart=2025-03-02&periodBEnd=2025-03-03").set(auth(qc))).status).toBe(400);
    expect((await request(app).get(cmp()).set(auth(prod))).status).toBe(403);
  });

  test("export de la comparaison : Excel (7 feuilles) et PDF, nommés par période", async () => {
    const x = await request(app).get(cmp("").replace("/comparison?", "/comparison/export?format=xlsx&")).set(auth(qc)).buffer(true).parse(binary);
    expect(x.status).toBe(200);
    expect(x.headers["content-disposition"]).toContain("Comparaison_Qualite_2025-03-01_2025-03-31.xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Synthèse", "Période A", "Période B", "Comparaison", "Par machine", "Par paramètre", "Points d'attention"]);
    const s1 = wb.getWorksheet("Comparaison");
    const values = [];
    s1.eachRow((r) => values.push(r.values.slice(1)));
    const total = values.find((v) => v[0] === "Contrôles");
    expect(total.slice(1, 4)).toEqual([4, 3, "-1 (-25,0 %)"]);
    const rate = values.find((v) => v[0] === "Taux de conformité");
    expect(rate[3]).toBe("0,0 pt");
    const p = await request(app).get(cmp("").replace("/comparison?", "/comparison/export?format=pdf&")).set(auth(qc)).buffer(true).parse(binary);
    expect(p.status).toBe(200);
    expect(p.body.toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(p.headers["content-disposition"]).toContain("Comparaison_Qualite_2025-03-01_2025-03-31.pdf");
  });
});
