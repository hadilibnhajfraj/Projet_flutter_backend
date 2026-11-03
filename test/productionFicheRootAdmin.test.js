"use strict";

// Modification / suppression des fiches PROBAR et PROMESH par le root admin
// (cbitunisia@cbi-tunisia.com, relu en base) — y compris fiches VALIDÉES
// (verrouillées), jamais les archivées — et journal production_fiche_audit.
// Les droits des autres comptes sont vérifiés inchangés.
//
// Base de DÉVELOPPEMENT locale. Les opérations portent UNIQUEMENT sur des
// fiches TEMPORAIRES créées par ce test (dates 2031), supprimées à la fin avec
// leurs lignes d'audit ; la séquence des numéros PROMESH est restaurée. Une
// empreinte (id + updatedAt) des fiches existantes vérifie qu'aucune n'a changé.

jest.mock("../src/utils/mailer", () => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "test" }), verifyConnection: jest.fn().mockResolvedValue({ ok: true }), maskEmail: (e) => e }));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));
jest.mock("../src/cron/rawMaterialRequestLate.job", () => ({}));

const request = require("supertest");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const PorPromesh = require("../src/models/PorPromesh");
const IndustrialRecord = require("../src/models/IndustrialRecord");
const ProductionFicheAudit = require("../src/models/ProductionFicheAudit");
const { signAccessToken } = require("../src/utils/tokens");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");
const { isRootAdminUser } = require("../src/config/rootAdmin");

const PASSWORD = process.env.BACKOFFICE_PASSWORD;
const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });

let ROOT, BAYREM, PROD1, PROD2, BO;
let seqBefore;
let fingerprintBefore;
const created = { promesh: [], probar: [] };

async function account(email) {
  const [u] = await sql(`SELECT id, email, role::text AS role, "isActive" FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte absent : ${email}`);
  return { user: u, auth: tokenFor(u) };
}

// Empreinte des fiches EXISTANTES (hors fiches temporaires du test).
async function fingerprint() {
  const ids = [...created.promesh, ...created.probar];
  const exclude = ids.length ? `WHERE id NOT IN (:ids)` : "";
  const [p] = await sql(`SELECT COUNT(*)::int AS n, md5(string_agg(id::text || "updatedAt"::text || status::text || "isLocked"::text, ',' ORDER BY id)) AS h FROM por_promesh ${exclude}`, { ids });
  const [b] = await sql(`SELECT COUNT(*)::int AS n, md5(string_agg(id::text || "updatedAt"::text || statut, ',' ORDER BY id)) AS h FROM industrial_records ${exclude}`, { ids });
  return { p, b };
}

async function newPromesh(fields) {
  const r = await PorPromesh.create({ machine: "3", poste: "matin", dateProduction: "2031-03-03", heureDebut: "06:00", heureFin: "14:00", operateur: "Opérateur test", createdBy: PROD1.user.id, ...fields });
  created.promesh.push(r.id);
  return r;
}

async function newProbar(fields) {
  const r = await IndustrialRecord.create({ module: "probar", machine: "1", poste: "matin", dateFiche: "2031-03-03", operateur: "Opérateur test", createdBy: PROD1.user.id, ...fields });
  created.probar.push(r.id);
  return r;
}

const audits = (ficheId) => ProductionFicheAudit.findAll({ where: { ficheId }, order: [["id", "ASC"]], raw: true });

beforeAll(async () => {
  [ROOT, BAYREM, PROD1, PROD2] = await Promise.all([
    account("cbitunisia@cbi-tunisia.com"),
    account("bayrem@gmail.com"),
    account("production_1@cbi-tunisia.com"),
    account("production_2@cbi-tunisia.com"),
  ]);
  _resetCache();
  if (PASSWORD) {
    const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
    expect(res.status).toBe(200);
    BO = { Authorization: `Bearer ${res.body.accessToken}`, permissions: res.body.user.permissions };
  }
  [seqBefore] = await sql(`SELECT last_value FROM "por_promesh_sequenceNumber_seq"`);
  fingerprintBefore = await fingerprint();
});

afterAll(async () => {
  const ids = [...created.promesh, ...created.probar];
  if (ids.length) {
    await ProductionFicheAudit.destroy({ where: { ficheId: ids } });
    await PorPromesh.destroy({ where: { id: created.promesh } });
    await IndustrialRecord.destroy({ where: { id: created.probar } });
  }
  const [{ m }] = await sql(`SELECT COALESCE(MAX("sequenceNumber"), 0) AS m FROM por_promesh`);
  await sequelize.query(`SELECT setval('"por_promesh_sequenceNumber_seq"', :v, true)`, { replacements: { v: Math.max(Number(seqBefore.last_value), Number(m)) } });
  expect(await fingerprint()).toEqual(fingerprintBefore); // aucune fiche existante modifiée
  await sequelize.close();
});

describe("root admin : identité vérifiée en base", () => {
  test("cbitunisia = root admin (superadmin actif) ; aucun autre compte", async () => {
    expect(isRootAdminUser(ROOT.user)).toBe(true);
    for (const a of [BAYREM, PROD1, PROD2]) expect([a.user.email, isRootAdminUser(a.user)]).toEqual([a.user.email, false]);
    expect(isRootAdminUser({ ...ROOT.user, isActive: false })).toBe(false);
    expect(isRootAdminUser({ ...ROOT.user, role: "admin" })).toBe(false);
  });

  (PASSWORD ? test : test.skip)("connexion back-office : productionFicheAdmin = false", () => {
    expect(BO.permissions.productionFicheAdmin).toBe(false);
  });

  test("jeton portant l'adresse du root admin mais l'id d'un autre compte : refusé (relecture en base)", async () => {
    const locked = await newPromesh({ status: "VALIDE", isLocked: true, validatedAt: new Date() });
    const forged = { Authorization: `Bearer ${signAccessToken({ sub: BAYREM.user.id, email: ROOT.user.email, role: "superadmin" })}` };
    const put = await request(app).put(`/por-promesh/${locked.id}`).set(forged).send({ operateur: "x" });
    expect([put.status, put.body.code]).toEqual([403, "SHEET_LOCKED"]);
    const del = await request(app).delete(`/por-promesh/${locked.id}`).set(forged);
    expect([del.status, del.body.code]).toEqual([403, "SHEET_LOCKED"]);
    expect(await audits(locked.id)).toEqual([]);
  });
});

describe("root admin : PROMESH", () => {
  test("modifie une fiche VALIDÉE : 200, verrouillage et validation inchangés, audit avant / après", async () => {
    const locked = await newPromesh({ status: "VALIDE", isLocked: true, validatedAt: new Date() });
    const res = await request(app).put(`/por-promesh/${locked.id}`).set(ROOT.auth).send({ operateur: "Opérateur corrigé" });
    expect(res.status).toBe(200);
    const after = await PorPromesh.findByPk(locked.id, { raw: true });
    expect([after.operateur, after.status, after.isLocked]).toEqual(["Opérateur corrigé", "VALIDE", true]);
    const [a] = await audits(locked.id);
    expect(a).toMatchObject({ ficheType: "PROMESH", action: "UPDATE", userId: ROOT.user.id, userEmail: ROOT.user.email, userRole: "superadmin", lockOverride: true });
    expect(a.ficheNumber).toMatch(/^PROMESH-\d{4}-\d{6}$/);
    expect(a.changes).toEqual({ operateur: { before: "Opérateur test", after: "Opérateur corrigé" } });
    expect(a.createdAt).toBeTruthy();
  });

  test("supprime une fiche VALIDÉE : 200, fiche supprimée, copie intégrale dans l'audit", async () => {
    const locked = await newPromesh({ status: "VALIDE", isLocked: true, validatedAt: new Date(), operateur: "À supprimer" });
    const res = await request(app).delete(`/por-promesh/${locked.id}`).set(ROOT.auth);
    expect(res.status).toBe(200);
    expect(await PorPromesh.findByPk(locked.id)).toBeNull();
    const [a] = await audits(locked.id);
    expect(a).toMatchObject({ ficheType: "PROMESH", action: "DELETE", userEmail: ROOT.user.email, lockOverride: true });
    expect(a.snapshot).toMatchObject({ id: locked.id, operateur: "À supprimer", status: "VALIDE", machine: "3", createdBy: PROD1.user.id });
    expect(Array.isArray(a.snapshot.controlesQualite)).toBe(true); // enfants inclus
  });

  test("fiche ARCHIVÉE : refusée même pour le root admin (demande de désarchivage)", async () => {
    const archived = await newPromesh({ status: "ARCHIVED", archivedAt: new Date(), archivedBy: "SYSTEM" });
    const put = await request(app).put(`/por-promesh/${archived.id}`).set(ROOT.auth).send({ operateur: "x" });
    expect([put.status, put.body.code]).toEqual([403, "SHEET_ARCHIVED"]);
    const del = await request(app).delete(`/por-promesh/${archived.id}`).set(ROOT.auth);
    expect([del.status, del.body.code]).toEqual([403, "SHEET_ARCHIVED"]);
    expect(await PorPromesh.findByPk(archived.id, { raw: true })).toMatchObject({ status: "ARCHIVED", operateur: "Opérateur test" });
    expect(await audits(archived.id)).toEqual([]);
  });
});

describe("root admin : PROBAR", () => {
  test("modifie une fiche validée : 200, statut inchangé, audit avant / après", async () => {
    const rec = await newProbar({ statut: "validee" });
    const res = await request(app).put(`/industrial-records/${rec.id}`).set(ROOT.auth).send({ operateur: "Opérateur corrigé" });
    expect(res.status).toBe(200);
    expect(await IndustrialRecord.findByPk(rec.id, { raw: true })).toMatchObject({ operateur: "Opérateur corrigé", statut: "validee" });
    const [a] = await audits(rec.id);
    expect(a).toMatchObject({ ficheType: "PROBAR", action: "UPDATE", userEmail: ROOT.user.email, lockOverride: true });
    expect(a.ficheNumber).toMatch(/^PROBAR-\d{4}-[0-9A-F]{6}$/);
    expect(a.changes).toEqual({ operateur: { before: "Opérateur test", after: "Opérateur corrigé" } });
  });

  test("supprime une fiche validée : 200, copie intégrale dans l'audit", async () => {
    const rec = await newProbar({ statut: "validee", operateur: "À supprimer" });
    const res = await request(app).delete(`/industrial-records/${rec.id}`).set(ROOT.auth);
    expect(res.status).toBe(200);
    expect(await IndustrialRecord.findByPk(rec.id)).toBeNull();
    const [a] = await audits(rec.id);
    expect(a).toMatchObject({ ficheType: "PROBAR", action: "DELETE", lockOverride: true });
    expect(a.snapshot).toMatchObject({ id: rec.id, module: "probar", operateur: "À supprimer", statut: "validee" });
  });

  test("fiche archivée : refusée même pour le root admin", async () => {
    const rec = await newProbar({ statut: "archivee" });
    const put = await request(app).put(`/industrial-records/${rec.id}`).set(ROOT.auth).send({ operateur: "x" });
    expect([put.status, put.body.code]).toEqual([403, "SHEET_ARCHIVED"]);
    const del = await request(app).delete(`/industrial-records/${rec.id}`).set(ROOT.auth);
    expect([del.status, del.body.code]).toEqual([403, "SHEET_ARCHIVED"]);
    expect(await audits(rec.id)).toEqual([]);
  });
});

describe("bouton Modifier : la bonne fiche s'ouvre et seule elle est enregistrée", () => {
  test.each([
    ["PROMESH 1", "promesh", "1"],
    ["PROMESH 4", "promesh", "4"],
    ["PROBAR", "probar", "2"],
  ])("%s validée : lecture par id (préremplissage) puis enregistrement de cette seule fiche", async (_label, type, machine) => {
    const isPromesh = type === "promesh";
    const make = (op) => (isPromesh
      ? newPromesh({ machine, poste: "nuit", status: "VALIDE", isLocked: true, operateur: op })
      : newProbar({ machine, poste: "nuit", statut: "validee", operateur: op }));
    const target = await make("Opérateur cible");
    const other = await make("Opérateur voisin"); // même machine, même équipe, même date
    const base = isPromesh ? "/por-promesh" : "/industrial-records";

    // 1. Ouverture par l'ID RÉEL : toutes les données enregistrées de CETTE fiche.
    const opened = await request(app).get(`${base}/${target.id}`).set(ROOT.auth);
    expect(opened.status).toBe(200);
    const fiche = opened.body.data ?? opened.body;
    expect({ id: fiche.id, machine: String(fiche.machine), poste: fiche.poste, operateur: fiche.operateur }).toEqual({ id: target.id, machine, poste: "nuit", operateur: "Opérateur cible" });

    // 2. Enregistrement : PUT de cette fiche uniquement.
    const saved = await request(app).put(`${base}/${target.id}`).set(ROOT.auth).send({ operateur: "Opérateur modifié" });
    expect(saved.status).toBe(200);
    const Model = isPromesh ? PorPromesh : IndustrialRecord;
    expect((await Model.findByPk(target.id, { raw: true })).operateur).toBe("Opérateur modifié");
    expect((await Model.findByPk(other.id, { raw: true })).operateur).toBe("Opérateur voisin"); // voisine intacte
    if (isPromesh) {
      const after = await PorPromesh.findByPk(target.id, { raw: true });
      expect([after.machine, after.status, after.isLocked]).toEqual([machine, "VALIDE", true]); // champs propres + validation conservés
    }
    expect((await audits(target.id)).map((a) => a.action)).toEqual(["UPDATE"]);
    expect(await audits(other.id)).toEqual([]);
  });
});

// Fiches RÉELLES de la base locale (lecture seule) : le GET utilisé par le
// mode modification renvoie TOUTES les valeurs enregistrées (colonnes et
// enfants) — ce qui est vide à l'écran l'est donc aussi en base.
describe("mode modification : le GET renvoie toutes les données de la fiche", () => {
  const same = (dbValue, apiValue) => {
    if (dbValue instanceof Date) return new Date(apiValue).getTime() === dbValue.getTime();
    if (typeof dbValue === "number" || (typeof dbValue === "string" && /^-?\d+(\.\d+)?$/.test(dbValue) && apiValue != null && typeof apiValue === "number")) return Number(dbValue) === Number(apiValue);
    return String(dbValue) === String(apiValue);
  };
  // Colonnes d'état / internes non exposées telles quelles par le DTO.
  const INTERNAL = new Set(["archivedAt", "archivedBy", "archiveReason", "unarchivedAt", "unarchivedBy", "approvalStatus", "approvalVersion", "approvalSubmittedAt", "approvalDecidedAt", "approvalDecidedBy", "approvalDecidedByEmail", "approvalRejectedAt", "approvalRejectionComment", "lot", "ordreFabrication"]);

  test.each([
    ["49d0ac95 (fiche signalée)", "49d0ac95-5b7b-4aa9-99f4-60830aa3cdf4"],
    ["43dc7b36 (PROMESH 1, données)", "43dc7b36-3d76-48a5-a3b4-bba727dffcc5"],
    ["95913d29 (PROMESH 4)", "95913d29-44a7-48fd-ac9d-0d7cbef6720d"],
  ])("PROMESH %s", async (_label, id) => {
    const [row] = await sql(`SELECT * FROM por_promesh WHERE id = :id`, { id });
    if (!row) return; // fiche absente de cette base
    const res = await request(app).get(`/por-promesh/${id}`).set(ROOT.auth);
    expect(res.status).toBe(200);
    const d = res.body.data;
    const missing = Object.entries(row)
      .filter(([k, v]) => v !== null && v !== "" && !INTERNAL.has(k))
      .filter(([k, v]) => !same(v, d[k]))
      .map(([k, v]) => `${k}: base=${v instanceof Date ? v.toISOString() : v} api=${d[k]}`);
    expect(missing).toEqual([]);
    for (const [table, key] of [["por_promesh_controles_qualite", "controlesQualite"], ["por_promesh_non_conformites", "nonConformites"], ["por_promesh_process_control", "processControl"], ["por_promesh_attachments", "attachments"], ["por_promesh_arrets_machine", "arretsMachine"], ["por_promesh_consommations", "consommations"]]) {
      const [{ n }] = await sql(`SELECT COUNT(*)::int AS n FROM ${table} WHERE "porPromeshId" = :id`, { id });
      expect([key, (d[key] || []).length]).toEqual([key, n]);
    }
  });

  test("PROBAR : une fiche réelle, toutes ses colonnes renseignées renvoyées", async () => {
    const [row] = await sql(`SELECT * FROM industrial_records WHERE module = 'probar' AND statut::text <> 'archivee' ORDER BY "updatedAt" DESC LIMIT 1`);
    if (!row) return;
    const res = await request(app).get(`/industrial-records/${row.id}`).set(ROOT.auth);
    expect(res.status).toBe(200);
    const d = res.body.data ?? res.body;
    for (const k of ["id", "machine", "poste", "operateur", "statut", "createdBy"]) {
      if (row[k] != null) expect([k, String(d[k])]).toEqual([k, String(row[k])]);
    }
    if (row.description) expect(typeof d.description === "string" ? d.description : JSON.stringify(d.description)).toBeTruthy();
  });
});

describe("autres comptes : droits inchangés", () => {
  (PASSWORD ? test : test.skip)("back-office : consultation oui, modification / suppression jamais (PROBAR et PROMESH)", async () => {
    const p = await newPromesh({ status: "VALIDE", isLocked: true });
    const b = await newProbar({ statut: "validee" });
    expect((await request(app).get(`/por-promesh/${p.id}`).set(BO)).status).toBe(200);
    expect((await request(app).get(`/industrial-records/${b.id}`).set(BO)).status).toBe(200);
    for (const [m, path] of [["put", `/por-promesh/${p.id}`], ["delete", `/por-promesh/${p.id}`], ["put", `/industrial-records/${b.id}`], ["delete", `/industrial-records/${b.id}`]]) {
      const r = await request(app)[m](path).set(BO).send({ operateur: "x" });
      expect([m, path, r.status, r.body.code]).toEqual([m, path, 403, "READ_ONLY_ACCOUNT"]);
    }
    expect([...(await audits(p.id)), ...(await audits(b.id))]).toEqual([]);
  });

  test("autre superadmin (bayrem) : fiche validée PROMESH toujours refusée ; brouillon modifiable comme avant (sans audit)", async () => {
    const locked = await newPromesh({ status: "VALIDE", isLocked: true });
    expect((await request(app).put(`/por-promesh/${locked.id}`).set(BAYREM.auth).send({ operateur: "x" })).body.code).toBe("SHEET_LOCKED");
    expect((await request(app).delete(`/por-promesh/${locked.id}`).set(BAYREM.auth)).body.code).toBe("SHEET_LOCKED");
    const draft = await newPromesh({ status: "BROUILLON" });
    expect((await request(app).put(`/por-promesh/${draft.id}`).set(BAYREM.auth).send({ operateur: "Modifié par bayrem" })).status).toBe(200);
    expect(await audits(draft.id)).toEqual([]); // seules les modifications du root admin sont journalisées
    // Suppression d'un brouillon (droit existant) : journalisée comme toute suppression.
    expect((await request(app).delete(`/por-promesh/${draft.id}`).set(BAYREM.auth)).status).toBe(200);
    expect((await audits(draft.id)).map((a) => [a.action, a.userEmail, a.lockOverride])).toEqual([["DELETE", BAYREM.user.email, false]]);
  });

  test("production_1 / production_2 : propres brouillons seulement, jamais une fiche validée, jamais de suppression", async () => {
    const own = await newPromesh({ status: "BROUILLON" });
    const locked = await newPromesh({ status: "VALIDE", isLocked: true });
    expect((await request(app).put(`/por-promesh/${own.id}`).set(PROD1.auth).send({ operateur: "Modifié par production_1" })).status).toBe(200);
    expect((await request(app).put(`/por-promesh/${locked.id}`).set(PROD1.auth).send({ operateur: "x" })).body.code).toBe("SHEET_LOCKED");
    expect((await request(app).put(`/por-promesh/${own.id}`).set(PROD2.auth).send({ operateur: "x" })).body.code).toBe("NOT_OWNER");
    for (const who of [PROD1, PROD2]) {
      expect([who.user.email, (await request(app).delete(`/por-promesh/${own.id}`).set(who.auth)).status]).toEqual([who.user.email, 403]);
    }
    const rec = await newProbar({ statut: "enregistree" });
    expect((await request(app).put(`/industrial-records/${rec.id}`).set(PROD1.auth).send({ operateur: "Modifié" })).status).toBe(200);
    expect((await request(app).put(`/industrial-records/${rec.id}`).set(PROD2.auth).send({ operateur: "x" })).body.code).toBe("NOT_OWNER");
    expect((await request(app).delete(`/industrial-records/${rec.id}`).set(PROD1.auth)).status).toBe(403);
    expect([...(await audits(own.id)), ...(await audits(rec.id))]).toEqual([]);
  });

  test("consultation : chaque ligne indique si la fiche est archivée", async () => {
    const res = await request(app).get(`/production-records?limit=200`).set(ROOT.auth);
    expect(res.status).toBe(200);
    for (const r of res.body.data) expect(typeof r.archived).toBe("boolean");
  });
});
