"use strict";

// Workflow d'autorisation Production — DEUX valideurs, UNE seule approbation :
//   responsable_logistique@cbi-tunisia.com (permissions production.*)
//   cbitunisia@cbi-tunisia.com (rôle superadmin RÉEL en base)
// Comptes réels, DB réelle, SMTP simulé. Tests numérotés comme le ticket
// ("TESTS OBLIGATOIRES" 1-7) + désarchivage (§6) et non-ré-archivage.
// Toutes les données créées sont supprimées en afterAll.

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test", accepted: [], rejected: [], response: "250 OK" }),
  verifyConnection: jest.fn().mockResolvedValue({ ok: true, host: "smtp.test", port: 587, secure: false }),
  maskEmail: (e) => e,
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const { Op, QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const EmailQueue = require("../src/models/EmailQueue");
const AuthRequest = require("../src/models/ProductionComplianceAuthorizationRequest");
const Authorization = require("../src/models/ProductionComplianceAuthorization");
const UnarchiveRequest = require("../src/models/ProductionUnarchiveRequest");
const ProductionRequestAudit = require("../src/models/ProductionRequestAudit");
const compliance = require("../src/modules/production-compliance/services/compliance.service");
const draftArchive = require("../src/modules/production-draft-archive/services/draftArchive.service");

const PASSWORD = process.env.PRODUCTION_TEST_PASSWORD || "ChangeMe123!";
const LOGISTIQUE = "responsable_logistique@cbi-tunisia.com";
const SUPERADMIN = "cbitunisia@cbi-tunisia.com";
const PROD1 = "production_1@cbi-tunisia.com";
const PROD2 = "production_2@cbi-tunisia.com";
// Jours ouvrés passés SANS fiche pour l'utilisateur concerné (vérifié en base) :
// le contrôle de rattrapage s'applique donc réellement.
const D_P1_APPROVED = "2026-09-23";
const D_P2_APPROVED = "2026-09-22";
const D_P2_REJECTED = "2026-09-21";
const D_P2_NO_REQUEST = "2026-09-18";
const START = new Date();

const created = { requestIds: [], unarchiveIds: [], ficheIds: [] };
const missingByProd = { PROD1: [], PROD2: [] };

async function signIn(email) {
  const res = await request(app).post("/auth/signin").send({ email, password: PASSWORD });
  return res.body;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function insertFiche({ userId, status, createdAgoHours, date }) {
  const [row] = await sequelize.query(
    `INSERT INTO por_promesh (id, "dateProduction", machine, poste, status, "isLocked", "createdBy", "archivedAt", "archivedBy", "archiveReason", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), :d, '1', 'matin', :status, false, :u,
             CASE WHEN :status = 'ARCHIVED' THEN NOW() ELSE NULL END,
             CASE WHEN :status = 'ARCHIVED' THEN 'SYSTEM' ELSE NULL END,
             CASE WHEN :status = 'ARCHIVED' THEN 'Brouillon > 2h (test)' ELSE NULL END,
             NOW() - (:h || ' hours')::interval, NOW())
     RETURNING id`,
    { replacements: { d: date, u: userId, status, h: String(createdAgoHours) }, type: QueryTypes.SELECT }
  );
  created.ficheIds.push(row.id);
  return row.id;
}

async function ficheStatus(id, transaction) {
  const [r] = await sequelize.query(`SELECT status FROM por_promesh WHERE id = :id`, { replacements: { id }, type: QueryTypes.SELECT, transaction });
  return r?.status;
}

describe("Autorisation Production — responsable logistique OU superadmin (une seule approbation)", () => {
  let tok; // { log, sa, p1, p2 }
  let users;
  let req1; // PROD1 → approuvée par le responsable logistique
  let req2; // PROD2 → approuvée par le superadmin
  let req3; // PROD2 → refusée
  let ficheP1;

  beforeAll(async () => {
    const [log, p1, p2] = await Promise.all([signIn(LOGISTIQUE), signIn(PROD1), signIn(PROD2)]);
    // Superadmin réel : jeton émis pour SON compte en base (même payload que
    // POST /auth/signin) — le droit est ensuite revérifié par son RÔLE en base.
    const sa = await User.findOne({ where: { email: SUPERADMIN } });
    tok = {
      log: log.accessToken,
      p1: p1.accessToken,
      p2: p2.accessToken,
      sa: signAccessToken({ sub: sa.id, email: sa.email, role: sa.role }),
    };
    users = { log: log.user, p1: p1.user, p2: p2.user, sa };

    // Seules les dates manquantes sont simulées (le reste du contrôle —
    // autorisation active, expiration, consommation — est le code réel).
    jest.spyOn(compliance, "blockingDates").mockImplementation(async (prod) => missingByProd[prod.key] || []);
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    const reqIds = [...created.requestIds, ...created.unarchiveIds];
    const authRows = created.requestIds.length ? await AuthRequest.findAll({ where: { id: created.requestIds } }) : [];
    const authIds = authRows.flatMap((r) => r.createdAuthorizationIds || []);
    if (reqIds.length) {
      await EmailQueue.destroy({ where: { [Op.or]: reqIds.map((id) => ({ dedupeKey: { [Op.like]: `%:${id}:%` } })) } });
      await ProductionRequestAudit.destroy({ where: { requestId: reqIds } });
    }
    if (authIds.length) await Authorization.destroy({ where: { id: authIds } });
    if (created.requestIds.length) await AuthRequest.destroy({ where: { id: created.requestIds } });
    if (created.unarchiveIds.length) await UnarchiveRequest.destroy({ where: { id: created.unarchiveIds } });
    if (created.ficheIds.length) {
      await sequelize.query(`DELETE FROM production_draft_archive_log WHERE "ficheId" IN (:ids)`, { replacements: { ids: created.ficheIds } });
      await sequelize.query(`DELETE FROM por_promesh WHERE id IN (:ids)`, { replacements: { ids: created.ficheIds } });
    }
    await Notification.destroy({ where: { createdAt: { [Op.gte]: START }, type: { [Op.like]: "production_%" } } });
    await sequelize.close();
  });

  const createFiche = (token, date) =>
    request(app).post("/por-promesh").set(auth(token)).send({ dateProduction: date, machine: "1", poste: "matin" });

  // ── TEST 1 ──────────────────────────────────────────────────────────────
  test("TEST 1 — production_1 crée une demande → PENDING, visible par les DEUX responsables", async () => {
    missingByProd.PROD1 = [D_P1_APPROVED];
    const res = await request(app).post("/production-compliance/requests").set(auth(tok.p1)).send({ reason: "Fiche non créée (panne)" });
    expect(res.status).toBe(201);
    req1 = res.body.data.id;
    created.requestIds.push(req1);
    expect(res.body.data).toMatchObject({ status: "PENDING", userEmail: PROD1, missingDates: [D_P1_APPROVED] });

    for (const t of [tok.log, tok.sa]) {
      const list = await request(app).get("/production-compliance/requests").set(auth(t));
      expect(list.status).toBe(200);
      expect(list.body.data.find((r) => r.id === req1)?.status).toBe("PENDING");
    }
  });

  // ── TEST 2 ──────────────────────────────────────────────────────────────
  test("TEST 2 — le responsable logistique APPROUVE → APPROVED, approuvé par lui, production_1 peut créer la fiche", async () => {
    const res = await request(app).post(`/production-compliance/requests/${req1}/approve`).set(auth(tok.log)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "APPROVED", reviewerEmail: LOGISTIQUE });
    const db = await AuthRequest.findByPk(req1);
    expect(db.reviewedBy).toBe(users.log.id);
    expect(db.reviewedAt).toBeTruthy();

    // Bandeau PROD : "Authorization granted" avec l'approbateur.
    const me = await request(app).get("/production-compliance/me").set(auth(tok.p1));
    expect(me.body.data.backfillDates).toEqual(expect.arrayContaining([expect.objectContaining({ date: D_P1_APPROVED, authorizedByEmail: LOGISTIQUE })]));

    const fiche = await createFiche(tok.p1, D_P1_APPROVED);
    expect(fiche.status).toBe(201);
    ficheP1 = fiche.body.data.id;
    created.ficheIds.push(ficheP1);

    const edit = await request(app).put(`/por-promesh/${ficheP1}`).set(auth(tok.p1)).send({ observationsGenerales: "Saisie de rattrapage" });
    expect(edit.status).toBe(200);
  });

  // ── TEST 7 (sur la demande du TEST 2) ───────────────────────────────────
  test("TEST 7 — autorisation consommée (USED) + traçabilité Approved by / Used by ; non réutilisable", async () => {
    const [authId] = (await AuthRequest.findByPk(req1)).createdAuthorizationIds;
    const a = await Authorization.findByPk(authId);
    expect(a).toMatchObject({ authorizedByEmail: LOGISTIQUE, usedBy: users.p1.id, usedByEmail: PROD1, usedFicheType: "PROMESH", usedFicheId: ficheP1 });
    expect(a.usedAt).toBeTruthy();
    expect((await AuthRequest.findByPk(req1)).status).toBe("USED");

    const hist = await request(app).get(`/production-requests/authorization/${req1}/history`).set(auth(tok.sa));
    expect(hist.status).toBe(200);
    expect(hist.body.data.usage).toEqual([expect.objectContaining({ date: D_P1_APPROVED, approvedByEmail: LOGISTIQUE, usedByEmail: PROD1, ficheId: ficheP1 })]);
    expect(hist.body.data.timeline.map((e) => e.code)).toEqual(["CREATED", "APPROVED", "USED"]);

    // Autorisation à usage unique : une 2e fiche pour cette date est refusée.
    const again = await createFiche(tok.p1, D_P1_APPROVED);
    expect(again.status).toBe(403);
    expect(again.body.code).toBe("BACKFILL_NOT_AUTHORIZED");
  });

  // ── TEST 3 ──────────────────────────────────────────────────────────────
  test("TEST 3 — production_2 demande, le SUPERADMIN (rôle en base) APPROUVE → APPROVED par cbitunisia", async () => {
    missingByProd.PROD2 = [D_P2_APPROVED];
    const res = await request(app).post("/production-compliance/requests").set(auth(tok.p2)).send({ reason: "Fiche non créée" });
    expect(res.status).toBe(201);
    req2 = res.body.data.id;
    created.requestIds.push(req2);

    expect(users.sa.role).toBe("superadmin");
    const ok = await request(app).post(`/production-compliance/requests/${req2}/approve`).set(auth(tok.sa)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: "APPROVED", reviewerEmail: SUPERADMIN });
  });

  // ── TEST 4 ──────────────────────────────────────────────────────────────
  test("TEST 4 — demande déjà APPROVED vue par l'autre responsable : APPROVED + traité par, plus aucune décision possible", async () => {
    const list = await request(app).get("/production-compliance/requests").set(auth(tok.log));
    const row = list.body.data.find((r) => r.id === req2);
    expect(row).toMatchObject({ status: "APPROVED", reviewerEmail: SUPERADMIN });
    expect(row.reviewedAt).toBeTruthy();

    const reject = await request(app).post(`/production-compliance/requests/${req2}/reject`).set(auth(tok.log)).send({ note: "tentative" });
    expect(reject.status).toBe(409);
    expect(reject.body.code).toBe("INVALID_STATE");
    const reApprove = await request(app).post(`/production-compliance/requests/${req2}/approve`).set(auth(tok.log)).send({});
    expect(reApprove.status).toBe(409);

    const db = await AuthRequest.findByPk(req2);
    expect(db).toMatchObject({ status: "APPROVED", reviewerEmail: SUPERADMIN });
  });

  test("TEST 3 (suite) — production_2 peut créer la fiche autorisée", async () => {
    const fiche = await createFiche(tok.p2, D_P2_APPROVED);
    expect(fiche.status).toBe(201);
    created.ficheIds.push(fiche.body.data.id);
    const [authId] = (await AuthRequest.findByPk(req2)).createdAuthorizationIds;
    expect(await Authorization.findByPk(authId)).toMatchObject({ authorizedByEmail: SUPERADMIN, usedByEmail: PROD2 });
  });

  // ── TEST 5 ──────────────────────────────────────────────────────────────
  test("TEST 5 — une demande REJECTED ne permet pas de créer la fiche et reste verrouillée", async () => {
    missingByProd.PROD2 = [D_P2_REJECTED];
    const res = await request(app).post("/production-compliance/requests").set(auth(tok.p2)).send({ reason: "Oubli" });
    expect(res.status).toBe(201);
    req3 = res.body.data.id;
    created.requestIds.push(req3);

    const rej = await request(app).post(`/production-compliance/requests/${req3}/reject`).set(auth(tok.log)).send({ note: "Motif insuffisant" });
    expect(rej.status).toBe(200);
    expect(rej.body.data).toMatchObject({ status: "REJECTED", reviewerEmail: LOGISTIQUE });

    const fiche = await createFiche(tok.p2, D_P2_REJECTED);
    expect(fiche.status).toBe(403);
    expect(fiche.body.code).toBe("BACKFILL_NOT_AUTHORIZED");

    // Un refus n'est jamais transformé en approbation par l'autre responsable.
    const approve = await request(app).post(`/production-compliance/requests/${req3}/approve`).set(auth(tok.sa)).send({});
    expect(approve.status).toBe(409);
    expect((await AuthRequest.findByPk(req3)).status).toBe("REJECTED");
  });

  // ── TEST 6 ──────────────────────────────────────────────────────────────
  test("TEST 6 — utilisateur PROD sans autorisation : 403, aucune écriture", async () => {
    const before = await sequelize.query(`SELECT count(*)::int n FROM por_promesh WHERE "createdBy" = :u`, { replacements: { u: users.p2.id }, type: QueryTypes.SELECT });
    const res = await createFiche(tok.p2, D_P2_NO_REQUEST);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BACKFILL_NOT_AUTHORIZED");
    const after = await sequelize.query(`SELECT count(*)::int n FROM por_promesh WHERE "createdBy" = :u`, { replacements: { u: users.p2.id }, type: QueryTypes.SELECT });
    expect(after[0].n).toBe(before[0].n);

    // production_1 ne peut pas re-dater la fiche d'un autre / ni approuver.
    const selfApprove = await request(app).post(`/production-compliance/requests/${req3}/approve`).set(auth(tok.p1)).send({});
    expect(selfApprove.status).toBe(403);
  });

  // ── §6 — Désarchivage : une approbation suffit, la fiche redevient éditable ─
  test("§6 — fiche archivée : 403 → demande → superadmin APPROUVE → fiche éditable ; l'autre responsable ne peut plus refuser", async () => {
    const ficheId = await insertFiche({ userId: users.p1.id, status: "ARCHIVED", createdAgoHours: 5, date: D_P1_APPROVED });

    const blocked = await request(app).put(`/por-promesh/${ficheId}`).set(auth(tok.p1)).send({ observationsGenerales: "x" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("SHEET_ARCHIVED");

    const ask = await request(app).post("/production-draft-archive/requests").set(auth(tok.p1)).send({ ficheType: "PROMESH", ficheId, reason: "Saisie interrompue" });
    expect(ask.status).toBe(201);
    const id = ask.body.data.id;
    created.unarchiveIds.push(id);

    for (const t of [tok.log, tok.sa]) {
      const list = await request(app).get("/production-draft-archive/requests").set(auth(t));
      expect(list.body.data.find((r) => r.id === id)?.status).toBe("PENDING");
    }

    const ok = await request(app).post(`/production-draft-archive/requests/${id}/approve`).set(auth(tok.sa)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: "APPROVED", reviewerEmail: SUPERADMIN });

    const late = await request(app).post(`/production-draft-archive/requests/${id}/reject`).set(auth(tok.log)).send({ note: "trop tard" });
    expect(late.status).toBe(409);

    expect(await ficheStatus(ficheId)).toBe("BROUILLON");
    const edit = await request(app).put(`/por-promesh/${ficheId}`).set(auth(tok.p1)).send({ observationsGenerales: "Complété après désarchivage" });
    expect(edit.status).toBe(200);
  });

  test("§6 — une demande de désarchivage REFUSÉE laisse la fiche archivée (403 en écriture)", async () => {
    const ficheId = await insertFiche({ userId: users.p2.id, status: "ARCHIVED", createdAgoHours: 5, date: D_P2_REJECTED });
    const ask = await request(app).post("/production-draft-archive/requests").set(auth(tok.p2)).send({ ficheType: "PROMESH", ficheId, reason: "x" });
    created.unarchiveIds.push(ask.body.data.id);
    const rej = await request(app).post(`/production-draft-archive/requests/${ask.body.data.id}/reject`).set(auth(tok.log)).send({ note: "Non justifié" });
    expect(rej.body.data.status).toBe("REJECTED");
    const approve = await request(app).post(`/production-draft-archive/requests/${ask.body.data.id}/approve`).set(auth(tok.sa)).send({});
    expect(approve.status).toBe(409);
    expect(await ficheStatus(ficheId)).toBe("ARCHIVED");
    const edit = await request(app).put(`/por-promesh/${ficheId}`).set(auth(tok.p2)).send({ observationsGenerales: "x" });
    expect(edit.status).toBe(403);
  });

  test("§6 — l'archivage automatique ne ré-archive PAS une fiche désarchivée depuis moins que le délai (8h) (régression)", async () => {
    // Fiche désarchivée à l'instant (createdAt au-delà du délai) + fiche
    // témoin brouillon au-delà du délai jamais archivée : seule la témoin
    // doit être archivée. Âges dérivés du délai réel (DRAFT_ARCHIVE_DELAY_HOURS).
    const delayH = draftArchive.DRAFT_ARCHIVE_DELAY_HOURS;
    const unarchived = await insertFiche({ userId: users.p1.id, status: "BROUILLON", createdAgoHours: delayH + 2, date: D_P1_APPROVED });
    await sequelize.query(`UPDATE por_promesh SET "unarchivedAt" = NOW(), "unarchivedBy" = :e WHERE id = :id`, { replacements: { id: unarchived, e: SUPERADMIN } });
    const control = await insertFiche({ userId: users.p1.id, status: "BROUILLON", createdAgoHours: delayH + 1, date: D_P1_APPROVED });

    const t = await sequelize.transaction();
    try {
      await draftArchive.sweepDraftArchivePromesh(new Date(), t);
      expect(await ficheStatus(control, t)).toBe("ARCHIVED");
      expect(await ficheStatus(unarchived, t)).toBe("BROUILLON");
      // Une fois le délai écoulé depuis le désarchivage, la règle normale s'applique à nouveau.
      await draftArchive.sweepDraftArchivePromesh(new Date(Date.now() + draftArchive.DRAFT_ARCHIVE_DELAY_MS + 60 * 1000), t);
      expect(await ficheStatus(unarchived, t)).toBe("ARCHIVED");
    } finally {
      await t.rollback(); // aucun effet réel sur les autres brouillons de la base
    }
  });
});
