"use strict";

// Édition des fiches PROMESH — PUT /por-promesh/:id (UPDATE partiel).
// Chaque vérification relit la ligne DIRECTEMENT dans PostgreSQL (pas
// seulement le HTTP 200). Données de test supprimées en afterAll.

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
const { QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");
const draftArchive = require("../src/modules/production-draft-archive/services/draftArchive.service");

const RUN_ID = Date.now();
const PASSWORD = "StrongPass123!";
const DATE = "2026-09-30";

const createdUsers = [];
const createdFiches = [];

async function makeUser(role, tag) {
  const u = await User.create({ email: `promesh-edit-${tag}-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash(PASSWORD, 12), isActive: true, role });
  createdUsers.push(u.id);
  const token = (await request(app).post("/auth/signin").send({ email: u.email, password: PASSWORD })).body.accessToken;
  return { user: u, token };
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function dbRow(id) {
  const [r] = await sequelize.query(
    `SELECT id, machine, poste, "dateProduction"::text AS "dateProduction", "productionM2"::text AS "productionM2",
            "totalDechetGraine"::text AS "totalDechetGraine", "totalChuteBarres"::text AS "totalChuteBarres",
            "diametreMaille1", "diametreMaille2", "heureFin"::text AS "heureFin", responsable1, status, "isLocked",
            "createdAt", "updatedAt"
       FROM por_promesh WHERE id = :id`,
    { replacements: { id }, type: QueryTypes.SELECT }
  );
  return r;
}

async function childIds(id) {
  const rows = await sequelize.query(
    `SELECT 'cq' AS t, id FROM por_promesh_controles_qualite WHERE "porPromeshId" = :id
     UNION ALL SELECT 'pc', id FROM por_promesh_process_control WHERE "porPromeshId" = :id
     UNION ALL SELECT 'am', id FROM por_promesh_arrets_machine WHERE "porPromeshId" = :id
     ORDER BY 1, 2`,
    { replacements: { id }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => `${r.t}:${r.id}`);
}

describe("PROMESH — édition (UPDATE partiel)", () => {
  let op; // opérateur Production (même rôle que production_1..5, hors contrôle PROD1/PROD2)
  let other; // autre opérateur du même rôle
  let admin;
  const fiches = {}; // machine → id

  const create = (machine, extra = {}) =>
    request(app)
      .post("/por-promesh")
      .set(auth(op.token))
      .send({
        machine,
        poste: "matin",
        dateProduction: DATE,
        heureDebut: "06:00",
        productionM2: 1500,
        totalDechetGraine: 20,
        totalChuteBarres: 5,
        diametreMaille1: "150x150",
        diametreMaille2: "8",
        personnelActif: { responsable1: "Resp A" },
        controlesQualite: [
          { heure: "06:00", maille: "150", longueur: 6, largeur: 2.4, statutCOQ: "C" },
          { heure: "09:00", maille: "150", longueur: 6, largeur: 2.4, statutCOQ: "C" },
        ],
        arretsMachine: [{ tArret: "10 min", observationMachine: "réglage" }],
        ...extra,
      });

  const put = (id, body, token = op.token) => request(app).put(`/por-promesh/${id}`).set(auth(token)).send(body);

  beforeAll(async () => {
    op = await makeUser("responsable_logistique_achat", "op");
    other = await makeUser("responsable_logistique_achat", "other");
    admin = await makeUser("superadmin", "admin");
  }, 30000);

  afterAll(async () => {
    if (createdFiches.length) {
      await sequelize.query(`DELETE FROM production_draft_archive_log WHERE "ficheId" IN (:ids)`, { replacements: { ids: createdFiches } });
      await sequelize.query(`DELETE FROM por_promesh WHERE id IN (:ids)`, { replacements: { ids: createdFiches } });
    }
    await User.destroy({ where: { id: createdUsers } });
    await sequelize.close();
  });

  test("TEST 1 — CREATE : fiche PROMESH 1..4 créées et relues en base", async () => {
    for (const m of ["1", "2", "3", "4"]) {
      const res = await create(m);
      expect(res.status).toBe(201);
      fiches[m] = res.body.data.id;
      createdFiches.push(fiches[m]);
      const db = await dbRow(fiches[m]);
      expect(db).toMatchObject({ machine: m, dateProduction: DATE, productionM2: "1500.00", totalDechetGraine: "20.00", diametreMaille2: "8", status: "BROUILLON" });
    }
  });

  test("TEST 2 / 13 / 14 — quantité seule : les autres champs, enfants, createdAt intacts ; updatedAt change", async () => {
    const id = fiches["1"];
    const before = await dbRow(id);
    const childrenBefore = await childIds(id);
    await new Promise((r) => setTimeout(r, 20));

    const res = await put(id, { productionM2: 1600 });
    expect(res.status).toBe(200);
    expect(res.body.data.productionM2).toBe("1600.00"); // réponse = état en base

    const after = await dbRow(id);
    expect(after.productionM2).toBe("1600.00");
    expect(after).toMatchObject({
      totalDechetGraine: "20.00",
      totalChuteBarres: "5.00",
      diametreMaille1: "150x150",
      diametreMaille2: "8",
      machine: "1",
      dateProduction: DATE,
      heureFin: null,
      responsable1: "Resp A",
    });
    // TEST 13 / 14
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // Tables enfants NON envoyées → jamais supprimées/recréées (mêmes ids).
    const childrenAfter = await childIds(id);
    expect(childrenAfter.filter((c) => !c.startsWith("pc:"))).toEqual(childrenBefore.filter((c) => !c.startsWith("pc:")));
    expect(childrenAfter.filter((c) => c.startsWith("cq:"))).toHaveLength(2);
  });

  test("TEST 3 — déchet seul", async () => {
    expect((await put(fiches["1"], { totalDechetGraine: 35 })).status).toBe(200);
    expect(await dbRow(fiches["1"])).toMatchObject({ totalDechetGraine: "35.00", productionM2: "1600.00", diametreMaille2: "8" });
  });

  test("TEST 4 — diamètre seul", async () => {
    expect((await put(fiches["1"], { diametreMaille2: "10" })).status).toBe(200);
    expect(await dbRow(fiches["1"])).toMatchObject({ diametreMaille2: "10", productionM2: "1600.00", totalDechetGraine: "35.00" });
  });

  test("TEST 5 — machine seule (aucun doublon, aucune autre fiche touchée)", async () => {
    const res = await put(fiches["3"], { machine: "1" });
    expect(res.status).toBe(200);
    expect(await dbRow(fiches["3"])).toMatchObject({ machine: "1", productionM2: "1500.00" });
    expect((await put(fiches["3"], { machine: "3" })).status).toBe(200); // remise en état
  });

  test("TEST 6 — plusieurs champs à la fois", async () => {
    const res = await put(fiches["2"], { productionM2: 2222.5, totalChuteBarres: 7, heureFin: "14:30", personnelActif: { responsable1: "Resp B" } });
    expect(res.status).toBe(200);
    expect(await dbRow(fiches["2"])).toMatchObject({
      productionM2: "2222.50",
      totalChuteBarres: "7.00",
      heureFin: "14:30:00",
      responsable1: "Resp B",
      totalDechetGraine: "20.00",
      diametreMaille2: "8",
      dateProduction: DATE,
    });
  });

  test("TEST 7 — aucune modification : le frontend n'envoie rien ; un PUT vide est refusé (400) et ne touche pas la fiche", async () => {
    const before = await dbRow(fiches["4"]);
    const res = await put(fiches["4"], {});
    expect(res.status).toBe(400);
    const after = await dbRow(fiches["4"]);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  test("TESTS 8-11 — modifier PROMESH 1/2/3/4 ne modifie jamais les autres fiches", async () => {
    for (const m of ["1", "2", "3", "4"]) {
      const snapshot = {};
      for (const o of ["1", "2", "3", "4"]) snapshot[o] = await dbRow(fiches[o]);
      expect((await put(fiches[m], { observationsGenerales: `modif PROMESH ${m}` })).status).toBe(200);
      for (const o of ["1", "2", "3", "4"].filter((x) => x !== m)) {
        const now = await dbRow(fiches[o]);
        expect(now.updatedAt.toISOString()).toBe(snapshot[o].updatedAt.toISOString());
        expect(now.machine).toBe(o);
      }
    }
  });

  test("TEST 12 — aucun doublon créé par les modifications", async () => {
    const [{ n }] = await sequelize.query(`SELECT count(*)::int n FROM por_promesh WHERE "createdBy" = :u`, { replacements: { u: op.user.id }, type: QueryTypes.SELECT });
    expect(n).toBe(4);
  });

  test("§12 — tableau enfant envoyé : remplacé exactement (ni perte ni doublon)", async () => {
    const res = await put(fiches["2"], {
      controlesQualite: [
        { heure: "06:00", maille: "150", longueur: 6, largeur: 2.4, statutCOQ: "C" },
        { heure: "09:00", maille: "150", longueur: 6, largeur: 2.4, statutCOQ: "NC" },
        { heure: "12:00", maille: "150", longueur: 6, largeur: 2.4, statutCOQ: "C" },
      ],
    });
    expect(res.status).toBe(200);
    const [{ n }] = await sequelize.query(`SELECT count(*)::int n FROM por_promesh_controles_qualite WHERE "porPromeshId" = :id`, { replacements: { id: fiches["2"] }, type: QueryTypes.SELECT });
    expect(n).toBe(3);
  });

  test("§8 — date de production conservée telle quelle, même sur un serveur UTC−x", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect((await put(fiches["4"], { dateProduction: DATE })).status).toBe(200);
      expect((await dbRow(fiches["4"])).dateProduction).toBe(DATE);
    } finally {
      process.env.TZ = previous;
      if (previous === undefined) delete process.env.TZ;
    }
  });

  test("TEST 15 / §3 — 404, 403 (autre utilisateur, VALIDÉE, ARCHIVÉE), 400 données invalides", async () => {
    expect((await put("00000000-0000-4000-8000-000000000000", { productionM2: 1 })).status).toBe(404);
    expect((await put(fiches["1"], { productionM2: 1 }, other.token)).status).toBe(403);
    expect((await put(fiches["1"], { productionM2: "abc" })).status).toBe(400);
    expect((await put(fiches["1"], { poste: "soir" })).status).toBe(400);

    await sequelize.query(`UPDATE por_promesh SET status = 'VALIDE', "isLocked" = true WHERE id = :id`, { replacements: { id: fiches["3"] } });
    const locked = await put(fiches["3"], { productionM2: 1 });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("SHEET_LOCKED");

    await sequelize.query(`UPDATE por_promesh SET status = 'ARCHIVED' WHERE id = :id`, { replacements: { id: fiches["4"] } });
    const archived = await put(fiches["4"], { productionM2: 1 });
    expect(archived.status).toBe(403);
    expect(archived.body.code).toBe("SHEET_ARCHIVED");
    expect((await dbRow(fiches["4"])).productionM2).toBe("1500.00");
  });

  test("TEST 16 / §18 — Production Summary et liste reflètent les valeurs modifiées", async () => {
    const list = await request(app).get(`/production-records?type=promesh&startDate=${DATE}&endDate=${DATE}&period=custom&limit=100`).set(auth(op.token));
    expect(list.status).toBe(200);
    const byId = Object.fromEntries(list.body.data.map((r) => [r.id, r]));
    expect(byId[`promesh:${fiches["1"]}`]).toMatchObject({ quantite: 1600, diametre: "10" });
    expect(byId[`promesh:${fiches["2"]}`]).toMatchObject({ quantite: 2222.5 });

    const summary = await request(app).get(`/production-records/summary?type=promesh&startDate=${DATE}&endDate=${DATE}&period=custom&status=all`).set(auth(op.token));
    expect(summary.status).toBe(200);
    const { rows, grandTotal } = summary.body.data.promesh;
    const mine = Object.fromEntries(rows.filter((r) => Object.values(fiches).map((id) => `promesh:${id}`).includes(r.id)).map((r) => [r.id, r]));
    // Lignes à jour, chacune sur SA machine (base du regroupement PROMESH 1/2/3 vs 4 côté écran).
    expect(mine[`promesh:${fiches["1"]}`]).toMatchObject({ quantite: 1600, machine: "1", diametre: "10" });
    expect(mine[`promesh:${fiches["2"]}`]).toMatchObject({ quantite: 2222.5, machine: "2" });
    expect(mine[`promesh:${fiches["4"]}`]).toMatchObject({ machine: "4", quantite: 1500 });
    // Total recalculé = somme exacte des lignes (aucune valeur figée).
    expect(grandTotal).toBeCloseTo(rows.reduce((s, r) => s + (r.quantite || 0), 0), 6);
  });

  test("§10 — l'édition ne repousse pas l'archivage 8h (calcul sur createdAt)", async () => {
    const res = await create("2", { dateProduction: DATE });
    const id = res.body.data.id;
    createdFiches.push(id);
    await sequelize.query(`UPDATE por_promesh SET "createdAt" = NOW() - interval '9 hours' WHERE id = :id`, { replacements: { id } });
    expect((await put(id, { productionM2: 999 })).status).toBe(200); // modifiée à l'instant
    expect((await dbRow(id)).createdAt.getTime()).toBeLessThan(Date.now() - 8.9 * 3600 * 1000);

    const t = await sequelize.transaction();
    try {
      await draftArchive.sweepDraftArchivePromesh(new Date(), t);
      const [r] = await sequelize.query(`SELECT status FROM por_promesh WHERE id = :id`, { replacements: { id }, type: QueryTypes.SELECT, transaction: t });
      expect(r.status).toBe("ARCHIVED");
    } finally {
      await t.rollback();
    }
  });

  test("DELETE — réservé aux admins ; opérateur 403, admin 200 et ligne supprimée", async () => {
    const res = await create("4");
    const id = res.body.data.id;
    createdFiches.push(id);
    expect((await request(app).delete(`/por-promesh/${id}`).set(auth(op.token))).status).toBe(403);
    expect((await request(app).delete(`/por-promesh/${id}`).set(auth(admin.token))).status).toBe(200);
    expect(await dbRow(id)).toBeUndefined();
  });
});
