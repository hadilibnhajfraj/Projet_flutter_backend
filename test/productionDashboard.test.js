"use strict";

// DASHBOARD PRODUCTION — GET /production-records/dashboard.
//
// LECTURE SEULE contre la vraie base de dev (aucune fiche créée, modifiée ou
// supprimée) : chaque chiffre renvoyé est comparé à une requête SQL
// indépendante et à « Production Summary » (mêmes règles, mêmes totaux).
// Même style que productionSummary.roleParity.test.js : le périmètre
// « superadmin » passe par un appel direct au service (mot de passe du compte
// réel inconnu), le périmètre owner-scoped par HTTP avec un compte seedé.

jest.mock("../src/utils/mailer", () => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "test" }), verifyConnection: jest.fn().mockResolvedValue({ ok: true }), maskEmail: (e) => e }));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const dashboard = require("../src/modules/production-records/services/productionDashboard.service");
const records = require("../src/modules/production-records/services/productionRecords.service");

const PASSWORD = "ChangeMe123!";
const LOGISTIQUE_EMAIL = "responsable_logistique@cbi-tunisia.com";
const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const ADMIN = { id: "00000000-0000-0000-0000-000000000000", role: "superadmin" };
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const sql = (query, replacements = {}) => sequelize.query(query, { replacements, type: sequelize.QueryTypes.SELECT });
const signIn = async (email) => (await request(app).post("/auth/signin").send({ email, password: PASSWORD })).body.accessToken;

// Comptages indépendants du service (une requête par table).
async function expected(type, { from = null, to = null, createdBy = null } = {}) {
  const promesh = type === "promesh";
  const table = promesh ? "por_promesh" : "industrial_records";
  const date = promesh ? `"dateProduction"` : `"dateFiche"`;
  const qty = promesh ? `"productionM2"` : `"quantiteProduite"`;
  const status = promesh ? "status::text" : "statut::text";
  const [archived, valid] = promesh ? ["ARCHIVED", "VALIDE"] : ["archivee", "validee"];
  const where = [promesh ? "TRUE" : "module = 'probar'"];
  if (from) where.push(`${date} >= :from AND ${date} <= :to`);
  if (createdBy) where.push(`"createdBy" = :createdBy`);
  const [row] = await sql(
    `SELECT COUNT(*)::int AS fiches,
            COUNT(*) FILTER (WHERE ${status} = '${valid}')::int AS validees,
            COUNT(*) FILTER (WHERE ${status} = '${archived}')::int AS archivees,
            COALESCE(SUM(${qty}) FILTER (WHERE ${status} = '${valid}'), 0)::float AS quantite,
            COUNT(DISTINCT machine) FILTER (WHERE machine IS NOT NULL)::int AS machines
       FROM ${table} WHERE ${where.join(" AND ")}`,
    { from, to, createdBy }
  );
  const wasteWhere = [`module = '${type.toUpperCase()}'`, "waste IS NOT NULL"];
  if (from) wasteWhere.push("date >= :from AND date <= :to");
  if (createdBy) wasteWhere.push(`"createdBy" = :createdBy`);
  const [w] = await sql(`SELECT COALESCE(SUM(waste), 0)::float AS dechets FROM recuperable_fiches WHERE ${wasteWhere.join(" AND ")}`, { from, to, createdBy });
  return { ...row, brouillons: row.fiches - row.validees - row.archivees, dechets: w.dechets };
}

describe("Dashboard Production — KPI calculés sur les données réelles", () => {
  let all;

  beforeAll(async () => {
    all = await dashboard.getDashboard({ period: "all" }, ADMIN);
  }, 30000);

  afterAll(async () => {
    await sequelize.close();
  });

  test("toutes périodes : fiches, statuts, quantité et déchets = requêtes SQL indépendantes", async () => {
    for (const type of ["promesh", "probar"]) {
      const e = await expected(type);
      expect(all[type]).toMatchObject({ fiches: e.fiches, validees: e.validees, archivees: e.archivees, brouillons: e.brouillons });
      expect(all[type].quantite).toBeCloseTo(e.quantite, 2);
      expect(all[type].dechets).toBeCloseTo(e.dechets, 2);
      expect(all[type].fiches).toBe(all[type].validees + all[type].brouillons + all[type].archivees);
    }
    expect(all.promesh).toMatchObject({ unit: "m²", wasteUnit: "kg", tauxDechetsUnit: "kg / 100 m²" });
    expect(all.probar).toMatchObject({ unit: "m", wasteUnit: "kg", tauxDechetsUnit: "kg / 100 m" });
    expect(all.production.fiches).toBe(all.promesh.fiches + all.probar.fiches);
    expect(all.waste.total).toBeCloseTo(all.promesh.dechets + all.probar.dechets, 2);
    expect(all.period).toEqual({ key: "all", start: null, end: null });
    expect(all.scope).toBe("all");
    expect(JSON.stringify(all)).not.toMatch(/NaN|Infinity/);
  });

  test("mêmes quantités que « Production Summary » (fiches validées)", async () => {
    const summary = await records.getProductionSummary({ type: "all", status: "validee" }, ADMIN);
    expect(all.promesh.quantite).toBeCloseTo(summary.promesh.grandTotal, 2);
    expect(all.promesh.validees).toBe(summary.promesh.totalRecords);
    expect(all.probar.quantite).toBeCloseTo(summary.probar.grandTotal, 2);
    expect(all.probar.validees).toBe(summary.probar.totalRecords);
  });

  test("taux de déchets = déchets / quantité × 100 (kg pour 100 unités), null sans production", () => {
    for (const line of [all.promesh, all.probar]) {
      const rate = line.quantite > 0 ? Math.round((line.dechets / line.quantite) * 10000) / 100 : null;
      expect(line.tauxDechets).toBe(rate);
      for (const m of line.machines) {
        expect(m.tauxDechets).toBe(m.quantite > 0 ? Math.round((m.dechets / m.quantite) * 10000) / 100 : null);
      }
    }
  });

  test("machines : Machine 1 à 4 par ligne, sommes = totaux de la ligne, machines actives comptées", async () => {
    let actives = 0;
    for (const type of ["promesh", "probar"]) {
      const line = all[type];
      expect(line.machines.slice(0, 4).map((m) => m.label)).toEqual(["Machine 1", "Machine 2", "Machine 3", "Machine 4"]);
      const withMachine = line.machines.reduce((s, m) => s + m.fiches, 0);
      const [{ n }] = await sql(type === "promesh" ? `SELECT COUNT(*)::int n FROM por_promesh WHERE machine IS NOT NULL` : `SELECT COUNT(*)::int n FROM industrial_records WHERE module = 'probar' AND machine IS NOT NULL`);
      expect(withMachine).toBe(n);
      for (const m of line.machines) {
        expect(m.active).toBe(m.fiches > 0);
        expect(m.fiches).toBe(m.validees + m.brouillons + m.archivees);
        if (m.fiches === 0) expect(m).toMatchObject({ quantite: 0, lastDate: null, lastStatut: null });
        else expect(["validee", "brouillon", "archivee"]).toContain(m.lastStatut);
      }
      actives += line.machines.filter((m) => m.active).length;
      // Dernière production d'une machine = date la plus récente de ses fiches.
      const m1 = line.machines[0];
      const [last] = await sql(type === "promesh" ? `SELECT to_char(MAX("dateProduction"), 'YYYY-MM-DD') d FROM por_promesh WHERE machine::text = '1'` : `SELECT to_char(MAX("dateFiche"), 'YYYY-MM-DD') d FROM industrial_records WHERE module = 'probar' AND machine::text = '1'`);
      expect(m1.lastDate).toBe(last.d);
    }
    expect(all.machines).toEqual({ actives, total: all.promesh.machines.length + all.probar.machines.length });
  });

  test("graphiques : une entrée par jour, sommes journalières = totaux ; dernières productions triées", () => {
    const days = all.charts.daily;
    expect(days.map((d) => d.date)).toEqual([...days.map((d) => d.date)].sort());
    expect(new Set(days.map((d) => d.date)).size).toBe(days.length);
    const sum = (k) => days.reduce((s, d) => s + d[k], 0);
    expect(sum("promesh")).toBeCloseTo(all.promesh.quantite, 1);
    expect(sum("probar")).toBeCloseTo(all.probar.quantite, 1);
    expect(sum("dechetsPromesh")).toBeCloseTo(all.promesh.dechets, 1);
    expect(sum("dechetsProbar")).toBeCloseTo(all.probar.dechets, 1);

    expect(all.recent.length).toBeLessThanOrEqual(10);
    expect(all.recent.length).toBe(Math.min(10, all.production.fiches));
    const dates = all.recent.map((r) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
    for (const r of all.recent) {
      expect(r.id).toMatch(/^(promesh|probar):[0-9a-f-]{36}$/);
      expect(["validee", "brouillon", "archivee"]).toContain(r.statut);
      expect(r.quantiteUnite).toBe(r.type === "promesh" ? "m²" : "m");
      expect(r.numero).toMatch(r.type === "promesh" ? /^PROMESH-\d{4}-\d{6}$/ : /^PROBAR-\d{4}-[0-9A-F]{6}$/);
    }
  });

  test("filtre période : personnalisée (août 2026) recalcule tout ; périodes prédéfinies bornées ; dates invalides → 400", async () => {
    const from = "2026-08-01";
    const to = "2026-08-31";
    const d = await dashboard.getDashboard({ period: "custom", startDate: from, endDate: to }, ADMIN);
    expect(d.period).toEqual({ key: "custom", start: from, end: to });
    for (const type of ["promesh", "probar"]) {
      const e = await expected(type, { from, to });
      expect(d[type]).toMatchObject({ fiches: e.fiches, validees: e.validees, archivees: e.archivees });
      expect(d[type].quantite).toBeCloseTo(e.quantite, 2);
      expect(d[type].dechets).toBeCloseTo(e.dechets, 2);
    }
    expect(d.charts.daily.every((x) => x.date >= from && x.date <= to)).toBe(true);
    expect(d.recent.every((r) => r.date >= from && r.date <= to)).toBe(true);
    // « Productions aujourd'hui » ne dépend pas de la période choisie.
    expect(d.production.today).toBe(all.production.today);

    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    for (const period of ["today", "week", "month", "year"]) {
      const p = (await dashboard.getDashboard({ period }, ADMIN)).period;
      expect(p.key).toBe(period);
      expect(p.end).toBe(iso);
      expect(p.start <= p.end).toBe(true);
    }
    expect((await dashboard.getDashboard({ period: "today" }, ADMIN)).period.start).toBe(iso);
    expect((await dashboard.getDashboard({ period: "year" }, ADMIN)).period.start).toBe(`${today.getFullYear()}-01-01`);
    // Sans période : mois en cours.
    expect((await dashboard.getDashboard({}, ADMIN)).period.key).toBe("month");

    await expect(dashboard.getDashboard({ period: "custom", startDate: "2026-08-01" }, ADMIN)).rejects.toMatchObject({ status: 400 });
    await expect(dashboard.getDashboard({ period: "custom", startDate: "2026-09-01", endDate: "2026-08-01" }, ADMIN)).rejects.toMatchObject({ status: 400 });
  });

  test("HTTP : un seul appel renvoie tout l'écran ; compte owner-scoped = ses propres fiches ; contrôle qualité et anonyme refusés", async () => {
    const token = await signIn(LOGISTIQUE_EMAIL);
    const res = await request(app).get("/production-records/dashboard?period=all").set(auth(token));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data)).toEqual(expect.arrayContaining(["promesh", "probar", "machines", "production", "waste", "charts", "recent", "period"]));
    expect(res.body.data.scope).toBe("own");
    const [user] = await sql(`SELECT id FROM users WHERE email = :email`, { email: LOGISTIQUE_EMAIL });
    for (const type of ["promesh", "probar"]) {
      const e = await expected(type, { createdBy: user.id });
      expect(res.body.data[type]).toMatchObject({ fiches: e.fiches, validees: e.validees });
      expect(res.body.data[type].quantite).toBeCloseTo(e.quantite, 2);
      expect(res.body.data[type].fiches).toBeLessThanOrEqual(all[type].fiches);
    }
    expect(res.body.data.recent.every((r) => r.userEmail === LOGISTIQUE_EMAIL)).toBe(true);

    const bad = await request(app).get("/production-records/dashboard?period=custom&startDate=abc&endDate=2026-08-01").set(auth(token));
    expect(bad.status).toBe(400);
    expect((await request(app).get("/production-records/dashboard")).status).toBe(401);
    const qc = await signIn(QC_EMAIL);
    expect((await request(app).get("/production-records/dashboard").set(auth(qc))).status).toBe(403);
    // Les routes existantes ne sont pas masquées par la nouvelle.
    expect((await request(app).get("/production-records/summary").set(auth(token))).status).toBe(200);
    expect((await request(app).get("/production-records?limit=1").set(auth(token))).status).toBe(200);
  });
});
