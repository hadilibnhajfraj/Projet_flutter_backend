"use strict";

// GET /production-records/fiches — liste d'une ligne (PROMESH / PROBAR).
// LECTURE SEULE contre la base de développement : chaque chiffre est comparé
// à une requête SQL indépendante. Vérifie la portée de lecture (identique
// aux listes par ligne), les filtres combinés, le statut de validation
// indépendant du verrouillage, la recherche par numéro complet, la
// pagination, et que GET /production-records n'est PAS modifié.

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
const svc = require("../src/modules/production-records/services/productionFiches.service");

const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const TABLE = {
  promesh: { table: "por_promesh", date: `"dateProduction"`, alive: `status::text <> 'ARCHIVED'` },
  probar: { table: "industrial_records", date: `"dateFiche"`, alive: `module = 'probar' AND statut::text <> 'archivee'` },
};

async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  return { user: u, auth: { Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` } };
}

async function expected(type, { createdBy = null, machine = null, poste = null, approval = undefined } = {}) {
  const t = TABLE[type];
  const where = [t.alive];
  if (createdBy) where.push(`"createdBy" = :createdBy`);
  if (machine) where.push(`machine::text = :machine`);
  if (poste) where.push(`poste::text = :poste`);
  if (approval === null) where.push(`"approvalStatus" IS NULL`);
  else if (approval) where.push(`"approvalStatus" = :approval`);
  const [r] = await sql(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE "approvalStatus" = 'APPROVED')::int AS approved,
            COUNT(*) FILTER (WHERE "approvalStatus" = 'PENDING')::int AS pending,
            COUNT(*) FILTER (WHERE "approvalStatus" = 'REJECTED')::int AS rejected,
            COUNT(*) FILTER (WHERE "approvalStatus" IS NULL)::int AS none
       FROM ${t.table} WHERE ${where.join(" AND ")}`,
    { createdBy, machine, poste, approval }
  );
  return r;
}

afterAll(() => sequelize.close());

describe("GET /production-records/fiches", () => {
  test("portée : responsables = toutes les fiches ; producteurs = les leurs (comme GET /por-promesh)", async () => {
    for (const email of ["responsable_production@cbi-tunisia.com", "responsable_logistique@cbi-tunisia.com", "production_1@cbi-tunisia.com", "production_2@cbi-tunisia.com"]) {
      const { user, auth } = await account(email);
      const manager = email.startsWith("responsable_");
      for (const type of ["promesh", "probar"]) {
        const res = await request(app).get(`/production-records/fiches?type=${type}&limit=100`).set(auth);
        expect(res.status).toBe(200);
        const e = await expected(type, { createdBy: manager ? null : user.id });
        expect(res.body.summary).toEqual(e);
        expect(res.body.pagination.total).toBe(e.total);
        expect(res.body.data).toHaveLength(Math.min(100, e.total));
        if (!manager) expect(res.body.data.every((r) => r.createdBy === user.id)).toBe(true);
        // Même portée que la liste par ligne existante.
        const legacy = type === "promesh" ? await request(app).get(`/por-promesh?skip=0&limit=1000`).set(auth) : await request(app).get(`/industrial-records?module=probar&pageSize=500`).set(auth);
        expect(legacy.body.data.length).toBe(e.total);
      }
    }
  });

  test("statut de validation ≠ verrouillage ; quantité et unité de la ligne ; fiches archivées exclues", async () => {
    const { auth } = await account("responsable_production@cbi-tunisia.com");
    for (const type of ["promesh", "probar"]) {
      const res = await request(app).get(`/production-records/fiches?type=${type}&limit=100`).set(auth);
      for (const r of res.body.data) {
        const [id] = [r.id.split(":")[1]];
        const [row] = await sql(`SELECT "approvalStatus" s, "approvalRejectionComment" c, ${type === "promesh" ? "status::text" : "statut::text"} AS saisie FROM ${TABLE[type].table} WHERE id = :id`, { id });
        expect(r.approval?.status ?? null).toBe(row.s);
        // Statut de saisie : mapping explicite de la colonne, jamais supposé.
        const saisie = { BROUILLON: "brouillon", VALIDE: "validee", brouillon: "brouillon", validee: "validee" }[row.saisie] || "inconnu";
        expect(r.statut).toBe(saisie);
        if (row.s === "REJECTED") {
          expect(r.approval.rejectionComment).toBe(row.c);
          expect(r.isLocked).toBe(false); // refus : correction autorisée
        }
        expect(r.quantiteUnite).toBe(type === "promesh" ? "m²" : "ml");
        expect(r.numero).toMatch(type === "promesh" ? /^PROMESH-\d{4}-\d{6}$/ : /^PROBAR-\d{4}-[0-9A-F]{6}$/);
      }
      // Aucune fiche archivée dans la liste.
      expect(res.body.data.every((r) => r.statut !== "archivee")).toBe(true);
      const ids = res.body.data.map((r) => r.id.split(":")[1]);
      if (ids.length) {
        const [n] = await sql(`SELECT COUNT(*)::int n FROM ${TABLE[type].table} WHERE id IN (:ids) AND NOT (${TABLE[type].alive})`, { ids });
        expect(n.n).toBe(0);
      }
    }
  });

  test("filtres combinés (machine + poste + statut) ; compteurs sur les mêmes filtres hors statut", async () => {
    const { auth } = await account("responsable_production@cbi-tunisia.com");
    const all = await request(app).get(`/production-records/fiches?type=promesh&machine=1&poste=matin&limit=100`).set(auth);
    const e = await expected("promesh", { machine: "1", poste: "matin" });
    expect(all.body.summary).toEqual(e);
    expect(all.body.data.every((r) => r.machine === "1" && r.poste === "matin")).toBe(true);
    for (const [approval, key] of [["REJECTED", "rejected"], ["APPROVED", "approved"], ["PENDING", "pending"], ["NONE", "none"]]) {
      const res = await request(app).get(`/production-records/fiches?type=promesh&machine=1&poste=matin&approval=${approval}&limit=100`).set(auth);
      expect(res.body.pagination.total).toBe(e[key]);
      expect(res.body.summary).toEqual(e); // les cartes gardent la répartition
      expect(res.body.data.every((r) => (r.approval?.status ?? "NONE") === approval)).toBe(true);
    }
  });

  test("recherche : numéro complet PROMESH / PROBAR, opérateur ; pagination stable", async () => {
    const { auth } = await account("responsable_production@cbi-tunisia.com");
    const [p] = await sql(`SELECT id, "sequenceNumber" seq, "createdAt" FROM por_promesh WHERE status::text <> 'ARCHIVED' AND "sequenceNumber" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1`);
    const numero = `PROMESH-${new Date(p.createdAt).getFullYear()}-${String(p.seq).padStart(6, "0")}`;
    const s1 = await request(app).get(`/production-records/fiches?type=promesh&search=${numero}`).set(auth);
    expect(s1.body.data.map((r) => r.numero)).toContain(numero);
    const [b] = await sql(`SELECT id FROM industrial_records WHERE module='probar' AND statut::text <> 'archivee' LIMIT 1`);
    const probarNumero = `PROBAR-2026-${b.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const s2 = await request(app).get(`/production-records/fiches?type=probar&search=${probarNumero}`).set(auth);
    expect(s2.body.data.map((r) => r.id)).toContain(`probar:${b.id}`);

    const p1 = await request(app).get(`/production-records/fiches?type=promesh&limit=10&page=1`).set(auth);
    const p2 = await request(app).get(`/production-records/fiches?type=promesh&limit=10&page=2`).set(auth);
    const ids = [...p1.body.data, ...p2.body.data].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // aucun doublon entre pages
    expect(p1.body.pagination).toMatchObject({ page: 1, limit: 10, totalPages: Math.ceil(p1.body.pagination.total / 10) });
  });

  test("erreurs : type manquant, période personnalisée invalide → 400 ; anonyme 401 ; contrôle qualité 403", async () => {
    const { auth } = await account("responsable_production@cbi-tunisia.com");
    expect((await request(app).get(`/production-records/fiches`).set(auth)).status).toBe(400);
    expect((await request(app).get(`/production-records/fiches?type=promesh&period=custom&startDate=2026-09-01`).set(auth)).status).toBe(400);
    expect((await request(app).get(`/production-records/fiches?type=promesh`)).status).toBe(401);
    const { auth: qc } = await account("controle_qualite@cbi-tunisia.com");
    expect((await request(app).get(`/production-records/fiches?type=promesh`).set(qc)).status).toBe(403);
  });

  test("non-régression : GET /production-records reste limité à ses propres fiches pour responsable_logistique", async () => {
    const { user, auth } = await account("responsable_logistique@cbi-tunisia.com");
    const res = await request(app).get(`/production-records?limit=100`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r) => r.createdBy === user.id)).toBe(true);
    expect(svc.isReadScoped(user)).toBe(false);
  });
});
