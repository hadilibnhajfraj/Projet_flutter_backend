"use strict";

// Bug « HTTP 403 sur /production/probar-summary » (compte back-office).
// Cause : le garde back-office rejouait les GET avec l'identité du compte de
// référence (rôle commercial) et requireRole des routes Production renvoyait
// 403 PERMISSION_DENIED. Correction : permission nommée production.read_all
// (config/rolePermissions.js), acceptée UNIQUEMENT sur les GET Production.
// Mêmes appels que l'écran (production_records_service.dart), connexion
// RÉELLE du back-office (BACKOFFICE_PASSWORD, jamais affiché), résultats
// comparés au compte administrateur. Base LOCALE, aucune donnée modifiée.

jest.mock("../src/utils/mailer", () => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "test" }), verifyConnection: jest.fn().mockResolvedValue({ ok: true }), maskEmail: (e) => e }));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));

const request = require("supertest");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");
const { requireRoleOrPermission } = require("../src/middleware/requireRole");
const { PERMISSIONS, roleHasPermission, permissionsOfRole, loadRolePermissions, lastLoadError, _resetCache: rolePermsReset } = require("../src/config/rolePermissions");

const PASSWORD = process.env.BACKOFFICE_PASSWORD;
const describeIfPassword = PASSWORD ? describe : describe.skip;
const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });
const uuidOf = (row) => String(row.id).split(":")[1];
const READ_ALL = PERMISSIONS.PRODUCTION_READ_ALL;

let BO;
let ADMIN;
let snapshot;

const get = (auth, path) => request(app).get(path).set(auth);
// Même comparaison qu'à l'écran : mêmes fiches (ids), mêmes totaux.
const summaryOf = (body, type) => {
  const t = body.data[type];
  return { ids: t.rows.map((r) => r.id).sort(), grandTotal: t.grandTotal, unit: t.unit, grandTotalWaste: t.grandTotalWaste, totalMatching: t.totalMatching };
};

async function fingerprint() {
  return sql(`SELECT
      (SELECT COUNT(*)::int FROM por_promesh) promesh, (SELECT MAX("updatedAt") FROM por_promesh) promesh_m,
      (SELECT COUNT(*)::int FROM por_promesh WHERE status::text = 'ARCHIVED') promesh_archived,
      (SELECT COUNT(*)::int FROM industrial_records) probar, (SELECT MAX("updatedAt") FROM industrial_records) probar_m,
      (SELECT COUNT(*)::int FROM industrial_records WHERE statut::text = 'archivee') probar_archived,
      (SELECT COUNT(*)::int FROM por_promesh_attachments) attachments`);
}

beforeAll(async () => {
  const [admin] = await sql(`SELECT id, email, role FROM users WHERE email = 'cbitunisia@cbi-tunisia.com'`);
  ADMIN = tokenFor(admin);
  _resetCache();
  if (PASSWORD) {
    const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user?.role).toBe("backoffice_readonly");
    BO = { Authorization: `Bearer ${res.body.accessToken}` };
  }
  snapshot = await fingerprint();
});

afterAll(async () => {
  expect(await fingerprint()).toEqual(snapshot); // aucune donnée de production modifiée
  await sequelize.close();
});

describe("permission production.read_all", () => {
  test("enregistrée en base (role_permissions) pour le seul rôle back-office", async () => {
    const rows = await sql(`SELECT role, permission FROM role_permissions ORDER BY role, permission`);
    expect(rows).toEqual([{ role: "backoffice_readonly", permission: "production.read_all" }]);
  });

  test("chargée depuis la base : back-office oui, aucun autre rôle", async () => {
    expect(READ_ALL).toBe("production.read_all");
    await loadRolePermissions({ force: true });
    expect(lastLoadError()).toBeNull();
    expect(roleHasPermission("backoffice_readonly", READ_ALL)).toBe(true);
    for (const role of ["commercial", "admin", "superadmin", "responsable_logistique_achat", "finance_production", "controle_qualite", undefined]) {
      expect([role, permissionsOfRole(role)]).toEqual([role, []]);
    }
  });

  test("requireRoleOrPermission : rôle listé OU permission en base, sinon 403 PERMISSION_DENIED", async () => {
    const mw = requireRoleOrPermission(READ_ALL, "admin");
    const run = async (role) => {
      const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      let passed = false;
      await mw({ user: role ? { role } : undefined, method: "GET", originalUrl: "/x" }, res, () => { passed = true; });
      return passed ? "next" : `${res.code} ${res.body?.code ?? ""}`.trim();
    };
    expect(await run("admin")).toBe("next");
    expect(await run("backoffice_readonly")).toBe("next");
    expect(await run("commercial")).toBe("403 PERMISSION_DENIED");
    expect(await run(undefined)).toBe("401");
  });

  (PASSWORD ? test : test.skip)("ligne absente de role_permissions : le back-office est refusé (aucune attribution en dur)", async () => {
    const realQuery = sequelize.query.bind(sequelize);
    // Simule une base SANS l'attribution — seule la lecture de role_permissions
    // est interceptée, aucune donnée n'est modifiée.
    const spy = jest.spyOn(sequelize, "query").mockImplementation((q, ...rest) =>
      String(q).startsWith("SELECT role, permission FROM role_permissions") ? Promise.resolve([]) : realQuery(q, ...rest)
    );
    try {
      _resetCache();
      rolePermsReset();
      const res = await get(BO, "/production-records/summary?type=probar");
      expect([res.status, res.body.code]).toEqual([403, "PERMISSION_DENIED"]);
    } finally {
      spy.mockRestore();
      _resetCache();
      rolePermsReset();
    }
    expect((await get(BO, "/production-records/summary?type=probar")).status).toBe(200);
  });

  (PASSWORD ? test : test.skip)("POST /auth/signin : la réponse contient production.read_all (lue en base)", async () => {
    const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("backoffice_readonly");
    expect(res.body.user.permissions).toEqual({
      probarProjectManager: false,
      readOnly: true,
      referenceEmail: "info@probardistribution.com",
      granted: ["production.read_all"],
    });
  });
});

describeIfPassword("back-office — appels réels de l'écran, comparés à l'administrateur", () => {
  test("1. récapitulatif PROBAR (appels de /production/probar-summary)", async () => {
    const filters = await get(BO, "/production-records/filters?scope=summary");
    expect(filters.status).toBe(200);
    const res = await get(BO, "/production-records/summary?type=probar&status=all");
    expect(res.status).toBe(200);
    expect(summaryOf(res.body, "probar")).toEqual(summaryOf((await get(ADMIN, "/production-records/summary?type=probar&status=all")).body, "probar"));
    // « all » : aucun filtre de statut (règle existante du récapitulatif) ;
    // par défaut : fiches validées uniquement.
    const [{ all, validees }] = await sql(`SELECT COUNT(*)::int "all", (COUNT(*) FILTER (WHERE statut::text = 'validee'))::int validees FROM industrial_records WHERE module = 'probar'`);
    expect(res.body.data.probar.rows.length).toBe(all);
    expect((await get(BO, "/production-records/summary?type=probar")).body.data.probar.rows.length).toBe(validees);
    expect(res.body.data.probar.unit).toBe("ml");
  });

  test("2. récapitulatif PROMESH", async () => {
    const res = await get(BO, "/production-records/summary?type=promesh&status=all");
    expect(res.status).toBe(200);
    expect(summaryOf(res.body, "promesh")).toEqual(summaryOf((await get(ADMIN, "/production-records/summary?type=promesh&status=all")).body, "promesh"));
    const [{ all, validees }] = await sql(`SELECT COUNT(*)::int "all", (COUNT(*) FILTER (WHERE status::text = 'VALIDE'))::int validees FROM por_promesh`);
    expect(res.body.data.promesh.rows.length).toBe(all);
    expect((await get(BO, "/production-records/summary?type=promesh")).body.data.promesh.rows.length).toBe(validees);
    expect(res.body.data.promesh.unit).toBe("m²");
  });

  test("3. résultats et totaux : somme des fiches = total, identiques à l'administrateur (statut par défaut et « all »)", async () => {
    for (const type of ["probar", "promesh"]) {
      for (const qs of [`type=${type}`, `type=${type}&status=all`]) {
        const mine = (await get(BO, `/production-records/summary?${qs}`)).body;
        const adm = (await get(ADMIN, `/production-records/summary?${qs}`)).body;
        expect([qs, summaryOf(mine, type)]).toEqual([qs, summaryOf(adm, type)]);
        const sum = mine.data[type].rows.reduce((s, r) => s + (r.quantite || 0), 0);
        expect(mine.data[type].grandTotal).toBeCloseTo(sum, 6);
      }
    }
  });

  test("4. filtres (machine, équipe, période, créateur) : identiques à l'administrateur", async () => {
    const [{ d1, d2 }] = await sql(`SELECT MIN("dateProduction")::text d1, MAX("dateProduction")::text d2 FROM por_promesh WHERE status::text <> 'ARCHIVED'`);
    const [prod2] = await sql(`SELECT id FROM users WHERE email = 'production_2@cbi-tunisia.com'`);
    for (const qs of [
      "type=promesh&status=all&machineId=1",
      "type=promesh&status=all&machineId=4",
      "type=promesh&status=all&poste=nuit",
      "type=probar&status=all&poste=matin",
      `type=promesh&status=all&period=custom&startDate=${d1}&endDate=${d2}`,
      `type=promesh&status=all&createdBy=${prod2.id}`,
    ]) {
      const type = qs.startsWith("type=probar") ? "probar" : "promesh";
      const mine = await get(BO, `/production-records/summary?${qs}`);
      expect([qs, mine.status]).toEqual([qs, 200]);
      expect([qs, summaryOf(mine.body, type)]).toEqual([qs, summaryOf((await get(ADMIN, `/production-records/summary?${qs}`)).body, type)]);
    }
    // Aucune restriction à son propre compte : fiches de PROD1 et PROD2, matin et nuit.
    const rows = (await get(BO, "/production-records/summary?type=promesh&status=all")).body.data.promesh.rows;
    const emails = (await sql(`SELECT DISTINCT u.email FROM por_promesh p JOIN users u ON u.id = p."createdBy" WHERE p.id IN (:ids)`, { ids: rows.map(uuidOf) })).map((x) => x.email);
    expect(emails).toEqual(expect.arrayContaining(["production_1@cbi-tunisia.com", "production_2@cbi-tunisia.com"]));
    expect(new Set(rows.map((r) => r.poste))).toEqual(new Set(["matin", "nuit"]));
  });

  test("5. ouvrir une fiche PROBAR (détail = administrateur)", async () => {
    const row = (await get(BO, "/production-records/summary?type=probar&status=all")).body.data.probar.rows[0];
    const res = await get(BO, `/industrial-records/${uuidOf(row)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual((await get(ADMIN, `/industrial-records/${uuidOf(row)}`)).body);
  });

  test("6. ouvrir une fiche PROMESH (détail = administrateur)", async () => {
    const row = (await get(BO, "/production-records/summary?type=promesh&status=all")).body.data.promesh.rows[0];
    const res = await get(BO, `/por-promesh/${uuidOf(row)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual((await get(ADMIN, `/por-promesh/${uuidOf(row)}`)).body);
  });

  test("7. télécharger un document : rapport PDF de la fiche", async () => {
    const row = (await get(BO, "/production-records/summary?type=promesh&status=all")).body.data.promesh.rows[0];
    const res = await request(app).get(`/por-promesh/${uuidOf(row)}/pdf`).set(BO).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.body.length).toBeGreaterThan(1000);
  });

  test("8. données qualité de la fiche : identiques à l'administrateur", async () => {
    const rows = (await get(BO, "/production-records/summary?type=promesh&status=all")).body.data.promesh.rows;
    for (const row of rows.slice(0, 5)) {
      const mine = (await get(BO, `/por-promesh/${uuidOf(row)}`)).body.data;
      const adm = (await get(ADMIN, `/por-promesh/${uuidOf(row)}`)).body.data;
      expect(Array.isArray(mine.controlesQualite)).toBe(true);
      expect(mine.controlesQualite).toEqual(adm.controlesQualite);
    }
    const central = await get(BO, `/production-records/${rows[0].id}`);
    expect(central.status).toBe(200);
    expect(central.body).toEqual((await get(ADMIN, `/production-records/${rows[0].id}`)).body);
  });

  test("9. endpoints GET Production : tous 200 (et 403 pour le compte de référence commercial)", async () => {
    const [p] = await sql(`SELECT id FROM por_promesh WHERE status::text <> 'ARCHIVED' AND "approvalStatus" IS NOT NULL LIMIT 1`);
    const [b] = await sql(`SELECT id FROM industrial_records WHERE module = 'probar' AND statut::text <> 'archivee' LIMIT 1`);
    const [info] = await sql(`SELECT id, email, role FROM users WHERE email = 'info@probardistribution.com'`);
    const paths = [
      "/production-records/filters", "/production-records/filters?scope=summary", "/production-records/summary",
      "/production-records/dashboard", "/production-records/fiches?type=probar", "/production-records/fiches?type=promesh",
      "/production-records/creators", "/production-records?limit=5",
      "/por-promesh", "/por-promesh/stats", "/por-promesh/dashboard", `/por-promesh/${p.id}`, `/por-promesh/${p.id}/pdf`,
      "/industrial-records", `/industrial-records/${b.id}`,
      `/production-fiche-approvals/promesh/${p.id}`,
    ];
    for (const path of paths) {
      expect([path, (await get(BO, path)).status]).toEqual([path, 200]);
      // Le compte de référence (commercial, sans la permission) reste refusé.
      expect([path, (await get(tokenFor(info), path)).status]).toEqual([path, 403]);
    }
  });

  test("10. modifications et suppressions : toujours 403", async () => {
    const [p] = await sql(`SELECT id FROM por_promesh WHERE status::text <> 'ARCHIVED' LIMIT 1`);
    const [b] = await sql(`SELECT id FROM industrial_records WHERE module = 'probar' LIMIT 1`);
    const writes = [
      ["post", "/por-promesh", { machine: "1" }],
      ["put", `/por-promesh/${p.id}`, { observationsGenerales: "x" }],
      ["patch", `/por-promesh/${p.id}`, { observationsGenerales: "x" }],
      ["delete", `/por-promesh/${p.id}`],
      ["post", `/por-promesh/${p.id}/validate`, {}],
      ["post", "/industrial-records", { machine: "1" }],
      ["put", `/industrial-records/${b.id}`, { observations: "x" }],
      ["delete", `/industrial-records/${b.id}`],
      ["post", `/production-fiche-approvals/promesh/${p.id}/approve`, {}],
      ["post", `/production-fiche-approvals/probar/${b.id}/reject`, { comment: "refus de test" }],
      ["post", "/production-draft-archive/requests", {}],
      ["post", "/quality-control", {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await request(app)[method](path).set(BO).send(body);
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
    // Décisions de validation : la permission ne les ouvre pas.
    const d = await get(BO, `/production-fiche-approvals/promesh/${p.id}`);
    if (d.status === 200) expect([d.body.data.canDecide, d.body.data.canResubmit]).toEqual([false, false]);
  });
});

describe("rôle relu en base et diagnostic des refus", () => {
  const logger = require("../src/utils/logger");
  let warn;
  beforeEach(() => {
    warn = jest.spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());
  const deniedLines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[PERMISSION-DENIED]"));
  const settle = () => new Promise((r) => setTimeout(r, 50)); // journalisation asynchrone (relecture en base)

  test("jeton portant le rôle back-office mais rôle différent en base : 403 + motif, jeton jamais journalisé", async () => {
    const [info] = await sql(`SELECT id, email, role FROM users WHERE email = 'info@probardistribution.com'`);
    const forged = signAccessToken({ sub: info.id, email: info.email, role: "backoffice_readonly" });
    const res = await request(app).get("/production-records/summary?type=probar").set({ Authorization: `Bearer ${forged}` });
    expect([res.status, res.body.code]).toEqual([403, "PERMISSION_DENIED"]);
    await settle();
    const [line] = deniedLines();
    expect(line).toContain(`email=${info.email}`);
    expect(line).toContain(`id=${info.id}`);
    expect(line).toContain("roleJwt=backoffice_readonly");
    expect(line).toContain(`roleBase=${info.role}`);
    expect(line).toContain('endpoint="GET /production-records/summary"');
    expect(line).toContain("attendu=production.read_all");
    expect(line).toContain("reconnexion requise");
    expect(line).not.toContain(forged);
    expect(line).not.toContain("type=probar"); // paramètres de requête non journalisés
  });

  test("refus de requireRoleOrPermission : diagnostic complet (rôle sans la permission)", async () => {
    const [info] = await sql(`SELECT id, email, role FROM users WHERE email = 'info@probardistribution.com'`);
    const res = await request(app).get("/production-records/summary").set(tokenFor(info));
    expect([res.status, res.body.code]).toEqual([403, "PERMISSION_DENIED"]);
    await settle();
    const [line] = deniedLines();
    expect(line).toContain(`roleBase=${info.role}`);
    expect(line).toContain("permissions=[]");
    expect(line).toContain("attendu=production.read_all ou rôle parmi [admin, superadmin, superadmin2, responsable_logistique_achat, finance_production]");
    expect(line).toContain(`motif="rôle « ${info.role} » absent de la liste et sans la permission production.read_all en base"`);
  });

  (PASSWORD ? test : test.skip)("back-office réel : rôle en base = rôle du jeton → 200, aucun refus journalisé", async () => {
    const [bo] = await sql(`SELECT role::text role, "isActive" FROM users WHERE email = 'backoffice@cbi-tunisia.com'`);
    expect(bo).toEqual({ role: "backoffice_readonly", isActive: true });
    expect((await get(BO, "/production-records/summary?type=probar")).status).toBe(200);
    await settle();
    expect(deniedLines()).toEqual([]);
  });
});

if (!PASSWORD) test.skip("BACKOFFICE_PASSWORD absent : tests du compte back-office non exécutés", () => {});
