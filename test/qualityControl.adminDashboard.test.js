"use strict";

// Module CONTRÔLE QUALITÉ — TABLEAU DE BORD SUPER ADMIN
// (GET /quality-control/admin/overview et /admin/controls), sur PostgreSQL réel.
//
// LECTURE SEULE : aucune fiche ni aucun compte créé. Les attentes sont
// recalculées en SQL direct sur les fiches existantes (quality_controls, hors
// suppressions logiques) ; les jetons sont signés pour des comptes EXISTANTS
// avec leur rôle réel (le rôle « admin », sans compte local, n'existe que dans
// le jeton). Une empreinte de la table vérifie qu'aucune donnée n'a changé.

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
const User = require("../src/models/User");
const { signAccessToken } = require("../src/utils/tokens");
const { rootAdminToken } = require("./helpers/rootAdminToken");
const svc = require("../src/modules/quality-control/services/qualityControl.service");

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const q = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const EFFECTIVE = svc.EFFECTIVE_TS_SQL;
const ALIVE = `FROM quality_controls WHERE "deletedAt" IS NULL`;

async function tokenFor(where, role) {
  const u = await User.findOne({ where });
  if (!u) return null;
  return signAccessToken({ sub: u.id, email: u.email, role: role || u.role });
}

const fingerprint = async () =>
  (await q(`SELECT md5(string_agg(id::text || COALESCE("updatedAt"::text,'') || status || COALESCE("validatedAt"::text,'') || COALESCE("deletedAt"::text,''), ',' ORDER BY id)) AS h FROM quality_controls`))[0].h;

describe("Contrôle Qualité — tableau de bord Super Admin", () => {
  let superAdmin; // superadmin + compte racine
  let superAdminOther; // autre compte superadmin (sans être racine)
  const denied = {}; // rôle → jeton
  let before;

  const overview = (query = "", token = superAdmin) => request(app).get(`/quality-control/admin/overview${query}`).set(auth(token));
  const list = (query = "", token = superAdmin) => request(app).get(`/quality-control/admin/controls${query}`).set(auth(token));
  // Toutes les pages d'une requête (limit=5) : vérifie aussi la pagination.
  async function allPages(query) {
    const sep = query ? "&" : "?";
    const first = await list(`${query}${sep}limit=5&page=1`);
    expect(first.status).toBe(200);
    const items = [...first.body.data];
    for (let p = 2; p <= first.body.pagination.totalPages; p++) {
      const res = await list(`${query}${sep}limit=5&page=${p}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(5);
      items.push(...res.body.data);
    }
    return { items, pagination: first.body.pagination };
  }

  beforeAll(async () => {
    superAdmin = await rootAdminToken();
    superAdminOther = await q(`SELECT id FROM users WHERE role = 'superadmin' AND email <> 'cbitunisia@cbi-tunisia.com' LIMIT 1`).then((r) =>
      r.length ? tokenFor({ id: r[0].id }) : null
    );
    denied.superadmin2 = await tokenFor({ role: "superadmin2" });
    denied.controle_qualite = await tokenFor({ role: "controle_qualite" });
    denied.commercial = await tokenFor({ role: "commercial" });
    denied.backoffice_readonly = await tokenFor({ role: "backoffice_readonly" });
    // Aucun compte local n'a le rôle « admin » : jeton seul, sans écriture.
    denied.admin = await tokenFor({ email: "cbitunisia@cbi-tunisia.com" }, "admin");
    before = await fingerprint();
  });

  afterAll(async () => {
    expect(await fingerprint()).toBe(before); // aucune donnée modifiée
    await sequelize.close();
  });

  test("portée : aucune restriction d'auteur pour le tableau de bord, inchangée ailleurs", () => {
    expect(svc.buildListWhere({}, null, { allAuthors: true })).toEqual({});
    expect(svc.buildListWhere({}, { id: "u", role: "controle_qualite" })).toEqual({ controllerUserId: "u" });
    expect(svc.buildListWhere({}, { id: "u", role: "superadmin" })).toHaveProperty("controllerUserId");
  });

  test("indicateurs = PostgreSQL (total, validées, en attente, conformes, non conformes, par produit)", async () => {
    const res = await overview();
    expect(res.status).toBe(200);
    const [t] = await q(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE "validatedAt" IS NOT NULL)::int validated,
        COUNT(*) FILTER (WHERE "validatedAt" IS NULL)::int pending,
        COUNT(*) FILTER (WHERE "validatedAt" IS NOT NULL AND status = 'CONFORME')::int conformes,
        COUNT(*) FILTER (WHERE "validatedAt" IS NOT NULL AND status = 'NON_CONFORME')::int "nonConformes" ${ALIVE}`);
    expect(res.body.data.totals).toEqual(t);
    expect(t.total).toBeGreaterThan(0); // la base locale contient des fiches réelles

    const byType = await q(`SELECT UPPER("productionType") AS type, COUNT(*)::int total,
        COUNT(*) FILTER (WHERE "validatedAt" IS NOT NULL)::int validated,
        COUNT(*) FILTER (WHERE "validatedAt" IS NULL)::int pending,
        COUNT(*) FILTER (WHERE "validatedAt" IS NOT NULL AND status = 'CONFORME')::int conformes,
        COUNT(*) FILTER (WHERE "validatedAt" IS NOT NULL AND status = 'NON_CONFORME')::int "nonConformes" ${ALIVE} GROUP BY 1`);
    const types = res.body.data.byProduct.map((l) => l.type);
    expect(types.slice(0, 2)).toEqual(["PROMESH", "PROBAR"]);
    for (const line of res.body.data.byProduct) {
      const { type, label, ...counts } = line;
      expect(label).toBeTruthy();
      const sql = byType.find((r) => r.type === type) || { total: 0, validated: 0, pending: 0, conformes: 0, nonConformes: 0 };
      const { type: _t, ...expected } = sql;
      expect(counts).toEqual(expected);
    }
    expect(res.body.data.byProduct.reduce((s, l) => s + l.total, 0)).toBe(t.total);
  });

  test("indicateurs sur une période (date effective du contrôle)", async () => {
    const [{ d }] = await q(`SELECT MIN((${EFFECTIVE})::date)::text AS d ${ALIVE}`);
    const from = d;
    const to = d;
    const res = await overview(`?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    const [{ n }] = await q(`SELECT COUNT(*)::int n ${ALIVE} AND (${EFFECTIVE})::date BETWEEN CAST(:from AS date) AND CAST(:to AS date)`, { from, to });
    expect(res.body.data.totals.total).toBe(n);
    expect(n).toBeGreaterThan(0);
  });

  test("liste : TOUTES les fiches, paginées sans doublon ni oubli", async () => {
    const ids = (await q(`SELECT id ${ALIVE}`)).map((r) => r.id).sort();
    const { items, pagination } = await allPages("");
    expect(pagination.total).toBe(ids.length);
    expect(pagination.totalPages).toBe(Math.max(1, Math.ceil(ids.length / 5)));
    expect(items.map((c) => c.id).sort()).toEqual(ids);
    // Champs du tableau.
    for (const c of items) {
      for (const k of ["reference", "productionType", "controlDate", "controlTime", "controllerEmail", "status", "isValidated", "updatedAt"]) {
        expect(c).toHaveProperty(k);
      }
    }
  });

  test("filtres : produit, état, résultat, période, recherche par numéro", async () => {
    const count = async (where, rep = {}) => (await q(`SELECT COUNT(*)::int n ${ALIVE} AND ${where}`, rep))[0].n;
    const total = async (query) => (await list(`${query}&limit=1`)).body.pagination.total;

    expect(await total("?productionType=PROBAR")).toBe(await count(`"productionType" = 'PROBAR'`));
    expect(await total("?productionType=PROMESH")).toBe(await count(`"productionType" = 'PROMESH'`));
    expect(await total("?state=draft")).toBe(await count(`"validatedAt" IS NULL`));
    expect(await total("?state=validated")).toBe(await count(`"validatedAt" IS NOT NULL`));
    expect(await total("?state=validated&status=NON_CONFORME")).toBe(await count(`"validatedAt" IS NOT NULL AND status = 'NON_CONFORME'`));
    expect(await total("?state=validated&status=CONFORME&productionType=PROMESH")).toBe(
      await count(`"validatedAt" IS NOT NULL AND status = 'CONFORME' AND "productionType" = 'PROMESH'`)
    );

    const [{ d }] = await q(`SELECT MAX((${EFFECTIVE})::date)::text AS d ${ALIVE}`);
    expect(await total(`?from=${d}&to=${d}`)).toBe(await count(`(${EFFECTIVE})::date = CAST(:d AS date)`, { d }));

    const [{ reference }] = await q(`SELECT reference ${ALIVE} ORDER BY "createdAt" LIMIT 1`);
    const res = await list(`?search=${encodeURIComponent(reference)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.reference)).toContain(reference);
    for (const c of res.body.data) expect(c.reference.toLowerCase().includes(reference.toLowerCase()) || c.ficheNumero || c.lot).toBeTruthy();
  });

  test("tri des colonnes (asc / desc) = ORDER BY PostgreSQL", async () => {
    const order = async (expr, dir) =>
      (await q(`SELECT id ${ALIVE} ORDER BY ${expr} ${dir}, ${EFFECTIVE} DESC, "createdAt" DESC, id ASC`)).map((r) => r.id);
    const cases = [
      ["reference", `reference`],
      ["productionType", `"productionType"`],
      ["date", EFFECTIVE],
      ["controller", `"controllerEmail"`],
      ["result", `status`],
      ["state", `("validatedAt" IS NOT NULL)`],
      ["updatedAt", `"updatedAt"`],
    ];
    for (const [key, expr] of cases) {
      for (const dir of ["asc", "desc"]) {
        const { items } = await allPages(`?sort=${key}&order=${dir}`);
        expect([key, dir, items.map((c) => c.id)]).toEqual([key, dir, await order(expr, dir.toUpperCase())]);
      }
    }
    expect((await list("?sort=password")).status).toBe(400);
    expect((await list("?order=sideways")).status).toBe(400);
    expect((await list("?state=refusee")).status).toBe(400);
  });

  test("détail complet de chaque fiche consultable (GET /quality-control/:id existant)", async () => {
    const { items } = await allPages("");
    for (const c of items) {
      const res = await request(app).get(`/quality-control/${c.id}`).set(auth(superAdmin));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(c.id);
      for (const k of ["readings", "physicalParameters", "specificParameters", "history"]) expect(res.body.data).toHaveProperty(k);
    }
  });

  test("tout compte du rôle superadmin y a accès ; aucun autre rôle (403), ni sans jeton (401)", async () => {
    if (superAdminOther) {
      expect((await overview("", superAdminOther)).status).toBe(200);
      expect((await list("", superAdminOther)).status).toBe(200);
    }
    for (const path of ["/quality-control/admin/overview", "/quality-control/admin/controls"]) {
      expect((await request(app).get(path)).status).toBe(401);
      for (const [role, token] of Object.entries(denied)) {
        if (!token) continue;
        const res = await request(app).get(path).set(auth(token));
        expect([role, path, res.status]).toEqual([role, path, 403]);
      }
    }
  });

  test("modules existants inchangés : liste et statistiques par rôle", async () => {
    const own = await request(app).get("/quality-control?limit=100").set(auth(denied.controle_qualite));
    expect(own.status).toBe(200);
    const [{ uid }] = await q(`SELECT id AS uid FROM users WHERE role = 'controle_qualite' LIMIT 1`);
    const [{ n }] = await q(`SELECT COUNT(*)::int n ${ALIVE} AND "controllerUserId" = :uid`, { uid });
    expect(own.body.pagination.total).toBe(n);
    expect((await request(app).get("/quality-control").set(auth(denied.superadmin2))).status).toBe(200);
    expect((await request(app).get("/quality-control/stats").set(auth(superAdmin))).status).toBe(200);
  });
});
