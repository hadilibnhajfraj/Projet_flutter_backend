"use strict";

// Workflow des demandes Production — responsable logistique.
// Parcours réel avec les comptes existants responsable_logistique@,
// production_1@ et production_2@cbi-tunisia.com (DB réelle, SMTP simulé),
// numérotés comme la liste "TESTS OBLIGATOIRES" du ticket. Toutes les
// données créées par le test sont supprimées en afterAll.

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
const mailer = require("../src/utils/mailer");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const EmailQueue = require("../src/models/EmailQueue");
const AuthRequest = require("../src/models/ProductionComplianceAuthorizationRequest");
const Authorization = require("../src/models/ProductionComplianceAuthorization");
const UnarchiveRequest = require("../src/models/ProductionUnarchiveRequest");
const ArchiveLog = require("../src/models/ProductionDraftArchiveLog");
const ProductionRequestAudit = require("../src/models/ProductionRequestAudit");
const compliance = require("../src/modules/production-compliance/services/compliance.service");
const notify = require("../src/modules/production-requests/services/notify.service");

const PASSWORD = process.env.PRODUCTION_TEST_PASSWORD || "ChangeMe123!";
const LOGISTIQUE = "responsable_logistique@cbi-tunisia.com";
const PROD1 = "production_1@cbi-tunisia.com";
const PROD2 = "production_2@cbi-tunisia.com";
const WORKFLOW_EMAIL = "productioncbiftunisia@gmail.com";
const MISSING_DATE = "2026-09-16";
const START = new Date();
const today = () => compliance.todayStr(new Date());

const created = { authRequestIds: [], authorizationIds: [], unarchiveIds: [], ficheIds: [], archiveLogIds: [], fakeRequestIds: [] };

async function signIn(email) {
  const res = await request(app).post("/auth/signin").send({ email, password: PASSWORD });
  return res.body;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

function workflowMails() {
  return mailer.sendMail.mock.calls.map(([m]) => m).filter((m) => String(m.subject).startsWith("[PRODUCTION]"));
}

describe("Workflow Production — responsable logistique", () => {
  let logToken;
  let logUser;
  let p1Token;
  let p2Token;
  let p2User;
  let baseline;
  let authRequestId;
  let unarchiveId;
  let ficheId;

  beforeAll(async () => {
    const s = await signIn(LOGISTIQUE);
    logToken = s.accessToken;
    logUser = s.user;
    p1Token = (await signIn(PROD1)).accessToken;
    const s2 = await signIn(PROD2);
    p2Token = s2.accessToken;
    p2User = s2.user;

    // Référence AVANT toute donnée de test (les compteurs sont comparés en delta).
    const stats = await request(app).get(`/production-requests/statistics?from=${today()}&to=${today()}`).set(auth(logToken));
    baseline = Object.fromEntries(stats.body.data.users.map((u) => [u.userEmail, u]));

    // Fiche PROMESH archivée automatiquement appartenant à production_2 —
    // SQL brut : le statut ARCHIVED existe en base (migration
    // 20260922160000) mais pas dans l'ENUM du modèle Sequelize.
    const [row] = await sequelize.query(
      `INSERT INTO por_promesh (id, "dateProduction", machine, poste, status, "isLocked", "createdBy", "archivedAt", "archivedBy", "archiveReason", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), :d, '2', 'matin', 'ARCHIVED', false, :u, NOW(), 'system', 'Brouillon > 2h (test)', NOW() - interval '3 hours', NOW())
       RETURNING id`,
      { replacements: { d: today(), u: p2User.id }, type: QueryTypes.SELECT }
    );
    ficheId = row.id;
    created.ficheIds.push(ficheId);
    const log = await ArchiveLog.create({
      ficheType: "PROMESH",
      ficheId,
      userId: p2User.id,
      userEmail: PROD2,
      dateProduction: today(),
      machine: "2",
      poste: "matin",
      ficheCreatedAt: new Date(Date.now() - 3 * 3600 * 1000),
      expiresAt: new Date(Date.now() - 3600 * 1000),
      archivedAt: new Date(),
      reason: "Brouillon > 2h (test)",
    });
    created.archiveLogIds.push(log.id);

  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    const reqIds = [...created.authRequestIds, ...created.unarchiveIds, ...created.fakeRequestIds];
    if (reqIds.length) {
      await EmailQueue.destroy({ where: { [Op.or]: reqIds.map((id) => ({ dedupeKey: { [Op.like]: `%:${id}:%` } })) } });
      await ProductionRequestAudit.destroy({ where: { requestId: reqIds } });
    }
    await ProductionRequestAudit.destroy({ where: { userEmail: [LOGISTIQUE, PROD1], createdAt: { [Op.gte]: START } } });
    if (created.authorizationIds.length) await Authorization.destroy({ where: { id: created.authorizationIds } });
    if (created.authRequestIds.length) await AuthRequest.destroy({ where: { id: created.authRequestIds } });
    if (created.unarchiveIds.length) await UnarchiveRequest.destroy({ where: { id: created.unarchiveIds } });
    if (created.archiveLogIds.length) await ArchiveLog.destroy({ where: { id: created.archiveLogIds } });
    if (created.ficheIds.length) await sequelize.query(`DELETE FROM por_promesh WHERE id IN (:ids)`, { replacements: { ids: created.ficheIds } });
    await Notification.destroy({
      where: {
        createdAt: { [Op.gte]: START },
        type: ["production_compliance_request", "production_compliance_authorization", "production_unarchive_request", "production_unarchive_rejected"],
      },
    });
    await sequelize.close();
  });

  // 1 — Connexion
  test("1. connexion responsable_logistique@cbi-tunisia.com (rôle inchangé, jamais admin)", () => {
    expect(logToken).toBeTruthy();
    expect(logUser.role).toBe("responsable_logistique_achat");
  });

  // 2 — Menu : le front s'appuie sur les permissions renvoyées par le backend
  test("2. permissions : 7 permissions production.* pour le responsable, aucune pour production_1", async () => {
    const log = await request(app).get("/production-requests/permissions").set(auth(logToken));
    expect(log.body.data.permissions.sort()).toEqual([
      "production.archive.approve",
      "production.archive.reject",
      "production.archive.view",
      "production.authorization.approve",
      "production.authorization.reject",
      "production.authorization.view",
      "production.statistics.view",
    ]);
    const p1 = await request(app).get("/production-requests/permissions").set(auth(p1Token));
    expect(p1.body.data.permissions).toEqual([]);
  });

  // 3 — Seules les demandes Production sont accessibles
  test.each([
    ["get", "/production-compliance/requests"],
    ["get", "/production-compliance/requests/stats"],
    ["get", "/production-draft-archive/requests"],
    ["get", "/production-draft-archive/archived-sheets"],
    ["get", "/production-requests/statistics"],
    ["get", "/production-requests/history"],
  ])("3. responsable logistique : 200 sur %s %s", async (method, path) => {
    const res = await request(app)[method](path).set(auth(logToken));
    expect(res.status).toBe(200);
  });

  test.each([
    ["get", "/production-compliance"], // contrôle journalier (responsables historiques)
    ["post", "/production-compliance/authorizations"], // autorisation directe
    ["post", "/production-compliance/run-check"],
    ["post", "/production-draft-archive/run-sweep"],
    ["put", "/hr-requests/00000000-0000-0000-0000-000000000000/accept"], // RH
    ["get", "/finance/dashboard"], // finance
    ["get", "/admin/users"], // admin
    ["get", "/users"],
  ])("3. responsable logistique : 403 sur %s %s", async (method, path) => {
    const res = await request(app)[method](path).set(auth(logToken)).send({});
    expect(res.status).toBe(403);
  });

  test.each([
    ["get", "/production-compliance/requests"],
    ["get", "/production-draft-archive/requests"],
    ["get", "/production-requests/statistics"],
  ])("3. production_1 (même rôle) reste refusé : 403 sur %s %s", async (method, path) => {
    const res = await request(app)[method](path).set(auth(p1Token));
    expect(res.status).toBe(403);
  });

  // 4-6 — Demande d'autorisation de production_1 + email
  test("4-6. production_1 crée une demande d'autorisation → visible chez le responsable + email", async () => {
    jest.spyOn(compliance, "blockingDates").mockResolvedValue([MISSING_DATE]);
    jest.spyOn(compliance, "activeBackfillAuth").mockResolvedValue(null);
    mailer.sendMail.mockClear();

    const res = await request(app).post("/production-compliance/requests").set(auth(p1Token)).send({ reason: "Fiche de production non créée" });
    expect(res.status).toBe(201);
    authRequestId = res.body.data.id;
    created.authRequestIds.push(authRequestId);
    expect(res.body.data.status).toBe("PENDING");

    // 5 — visible chez le responsable logistique
    const list = await request(app).get("/production-compliance/requests").set(auth(logToken));
    const row = list.body.data.find((r) => r.id === authRequestId);
    expect(row).toMatchObject({ userEmail: PROD1, production: "PROD1", status: "PENDING", reason: "Fiche de production non créée" });
    expect(row.expiresAt).toBeTruthy();

    // 6 — email workflow
    const mails = workflowMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(WORKFLOW_EMAIL);
    expect(mails[0].subject).toBe("[PRODUCTION] Nouvelle demande d'autorisation");
    for (const expected of [PROD1, "PROD 1", "16/09/2026", "Autorisation de backfill", "Fiche de production non créée", "PROBAR — CBI Tunisia"]) {
      expect(mails[0].text).toContain(expected);
    }
    const queued = await EmailQueue.findAll({ where: { dedupeKey: { [Op.like]: `%:${authRequestId}:%` } } });
    expect(queued.map((q) => [q.to, q.status])).toEqual([[WORKFLOW_EMAIL, "SENT"]]);
  });

  // 18 — pas de doublon
  test("18. aucun doublon d'email : re-soumission / rejeu de la notification", async () => {
    const before = workflowMails().length;
    const again = await request(app).post("/production-compliance/requests").set(auth(p1Token)).send({ reason: "Fiche de production non créée" });
    expect(again.body.alreadyPending).toBe(true);
    const row = await AuthRequest.findByPk(authRequestId);
    const replay1 = await notify.notifyAuthorizationRequestCreated(row);
    const replay2 = await notify.notifyAuthorizationRequestCreated(row);
    expect(replay1[0].duplicate).toBe(true);
    expect(replay2[0].duplicate).toBe(true);
    expect(workflowMails().length).toBe(before);
    expect(await EmailQueue.count({ where: { dedupeKey: { [Op.like]: `%:${authRequestId}:%` } } })).toBe(1);
  });

  // 7-8 — Approbation
  test("7-8. le responsable approuve → APPROVED + audit (ancienne/nouvelle valeur)", async () => {
    const res = await request(app).post(`/production-compliance/requests/${authRequestId}/approve`).set(auth(logToken)).send({ note: "OK logistique" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("APPROVED");
    expect(res.body.data.reviewerEmail).toBe(LOGISTIQUE);
    created.authorizationIds.push(...res.body.authorizationIds);

    const db = await AuthRequest.findByPk(authRequestId);
    expect(db.status).toBe("APPROVED");

    await new Promise((r) => setTimeout(r, 200)); // audit écrit sur "finish"
    const audit = await ProductionRequestAudit.findOne({ where: { requestId: authRequestId, action: "APPROVE" } });
    expect(audit).toMatchObject({ userId: logUser.id, userEmail: LOGISTIQUE, oldValue: "PENDING", newValue: "APPROVED", outcome: "SUCCESS", requestType: "AUTHORIZATION" });
  });

  test("production_1 ne peut pas décider (403) et la tentative est tracée", async () => {
    const res = await request(app).post(`/production-compliance/requests/${authRequestId}/reject`).set(auth(p1Token)).send({ note: "x" });
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 200));
    expect(await ProductionRequestAudit.count({ where: { requestId: authRequestId, outcome: "DENIED", userEmail: PROD1 } })).toBe(1);
  });

  // 9-10 — Demande de désarchivage de production_2 + email
  test("9-10. production_2 demande un désarchivage → visible + email", async () => {
    mailer.sendMail.mockClear();
    const res = await request(app)
      .post("/production-draft-archive/requests")
      .set(auth(p2Token))
      .send({ ficheType: "PROMESH", ficheId, reason: "Saisie interrompue par une panne" });
    expect(res.status).toBe(201);
    unarchiveId = res.body.data.id;
    created.unarchiveIds.push(unarchiveId);

    const list = await request(app).get("/production-draft-archive/requests").set(auth(logToken));
    expect(list.body.data.find((r) => r.id === unarchiveId)).toMatchObject({ userEmail: PROD2, status: "PENDING" });

    const mails = workflowMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(WORKFLOW_EMAIL);
    expect(mails[0].subject).toBe("[PRODUCTION] Nouvelle demande de désarchivage");
    for (const expected of [PROD2, "PROD 2", "Désarchivage de fiche PROMESH", "Saisie interrompue par une panne"]) {
      expect(mails[0].text).toContain(expected);
    }
  });

  // 11-12 — Refus
  test("11-12. le responsable refuse → REJECTED, la fiche reste archivée", async () => {
    const noReason = await request(app).post(`/production-draft-archive/requests/${unarchiveId}/reject`).set(auth(logToken)).send({});
    expect(noReason.status).toBe(400);

    const res = await request(app).post(`/production-draft-archive/requests/${unarchiveId}/reject`).set(auth(logToken)).send({ note: "Fiche à ressaisir" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "REJECTED", reviewerEmail: LOGISTIQUE });

    const [fiche] = await sequelize.query(`SELECT status FROM por_promesh WHERE id = :id`, { replacements: { id: ficheId }, type: QueryTypes.SELECT });
    expect(fiche.status).toBe("ARCHIVED");

    await new Promise((r) => setTimeout(r, 200));
    const audits = await ProductionRequestAudit.findAll({ where: { requestId: unarchiveId, action: "REJECT" }, order: [["createdAt", "ASC"]] });
    expect(audits.map((a) => [a.outcome, a.newValue])).toEqual([
      ["FAILED", null],
      ["SUCCESS", "REJECTED"],
    ]);
  });

  // 13-14 — Statistiques
  test("13-14. statistiques dynamiques : compteurs différents pour production_1 et production_2", async () => {
    const res = await request(app).get(`/production-requests/statistics?from=${today()}&to=${today()}`).set(auth(logToken));
    expect(res.status).toBe(200);
    const byUser = Object.fromEntries(res.body.data.users.map((u) => [u.userEmail, u]));
    const d = (email, key) => byUser[email][key] - (baseline[email]?.[key] || 0);

    expect(byUser[PROD1].productionLabel).toBe("PROD 1");
    expect(byUser[PROD2].productionLabel).toBe("PROD 2");
    expect(d(PROD1, "authorizationRequests")).toBe(1);
    expect(d(PROD1, "approved")).toBe(1);
    expect(d(PROD1, "unarchiveRequests")).toBe(0);
    expect(d(PROD2, "unarchiveRequests")).toBe(1);
    expect(d(PROD2, "rejected")).toBe(1);
    expect(d(PROD2, "archiveEvents")).toBe(1);
    expect(d(PROD2, "authorizationRequests")).toBe(0);
    // 14 — compteurs propres à chaque utilisateur (jamais partagés/statiques).
    expect([d(PROD1, "authorizationRequests"), d(PROD1, "unarchiveRequests")]).toEqual([1, 0]);
    expect([d(PROD2, "authorizationRequests"), d(PROD2, "unarchiveRequests")]).toEqual([0, 1]);

    const k = res.body.data.kpis;
    expect(k.total).toBe(k.authorizationRequests + k.unarchiveRequests);
    expect(k.total).toBe(k.pending + k.approved + k.rejected + k.expired);
    expect(res.body.data.timeline.length).toBeGreaterThan(0);
  });

  // 15 — Filtres
  test("15. filtres production / type / statut / utilisateur / période", async () => {
    const q = (s) => request(app).get(`/production-requests/statistics?from=${today()}&to=${today()}&${s}`).set(auth(logToken));

    const prod1 = await q("production=PROD1");
    expect(prod1.body.data.users.map((u) => u.userEmail)).toEqual([PROD1]);

    const unarchive = await q("type=UNARCHIVE");
    expect(unarchive.body.data.kpis.authorizationRequests).toBe(0);
    expect(unarchive.body.data.kpis.unarchiveRequests).toBeGreaterThanOrEqual(1);

    const rejected = await q("status=REJECTED");
    expect(rejected.body.data.kpis.approved).toBe(0);
    expect(rejected.body.data.kpis.pending).toBe(0);

    const byUserId = await q(`userId=${p2User.id}`);
    expect(byUserId.body.data.users.map((u) => u.userEmail)).toEqual([PROD2]);

    const past = await request(app).get("/production-requests/statistics?from=2020-01-01&to=2020-01-31").set(auth(logToken));
    expect(past.body.data.kpis.total).toBe(0);

    const month = await q("granularity=month");
    expect(month.body.data.timeline[0].period).toMatch(/^\d{4}-\d{2}$/);

    expect((await q("status=FOO")).status).toBe(400);
  });

  // 16 — Historique
  test("16. historique : lignes traitées avec responsable + historique détaillé d'une demande", async () => {
    const res = await request(app).get(`/production-requests/history?from=${today()}&to=${today()}`).set(auth(logToken));
    const a = res.body.data.find((r) => r.id === authRequestId);
    const u = res.body.data.find((r) => r.id === unarchiveId);
    expect(a).toMatchObject({ type: "AUTHORIZATION", userLabel: "production_1", productionLabel: "PROD 1", status: "APPROVED", reviewerEmail: LOGISTIQUE });
    expect(u).toMatchObject({ type: "UNARCHIVE", userLabel: "production_2", productionLabel: "PROD 2", status: "REJECTED", reviewerEmail: LOGISTIQUE });
    expect(a.date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(a.time).toMatch(/^\d{2}:\d{2}$/);

    const detail = await request(app).get(`/production-requests/authorization/${authRequestId}/history`).set(auth(logToken));
    expect(detail.status).toBe(200);
    expect(detail.body.data.timeline.map((e) => e.code)).toEqual(["CREATED", "APPROVED"]);
    expect(detail.body.data.audit.some((x) => x.action === "APPROVE" && x.newValue === "APPROVED")).toBe(true);
    expect(detail.body.data.emails).toEqual([expect.objectContaining({ to: WORKFLOW_EMAIL, status: "SENT" })]);

    await new Promise((r) => setTimeout(r, 200));
    expect(await ProductionRequestAudit.count({ where: { requestId: authRequestId, action: "VIEW_HISTORY", userEmail: LOGISTIQUE } })).toBe(1);
  });

  // 17 — Jamais d'email client
  test("17. aucun email à un client : destinataires du workflow = adresse interne uniquement", async () => {
    const rows = await EmailQueue.findAll({ where: { context: notify.CONTEXT, createdAt: { [Op.gte]: START } } });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.to))).toEqual(new Set([WORKFLOW_EMAIL]));
    for (const m of workflowMails()) expect(m.to).toBe(WORKFLOW_EMAIL);

    // Garde-fou : une adresse de contact client mal configurée est refusée.
    const [client] = await sequelize.query(`SELECT email FROM commercial_contacts WHERE email IS NOT NULL AND email <> '' LIMIT 1`, { type: QueryTypes.SELECT });
    if (!client) return;
    const prev = process.env.PRODUCTION_WORKFLOW_NOTIFY_EMAILS;
    process.env.PRODUCTION_WORKFLOW_NOTIFY_EMAILS = client.email;
    mailer.sendMail.mockClear();
    const fakeId = "11111111-1111-4111-8111-111111111111";
    created.fakeRequestIds.push(fakeId);
    const out = await notify.notifyAuthorizationRequestCreated({ id: fakeId, userEmail: PROD1, productionType: "PROD1", missingDates: [MISSING_DATE], requestedAt: new Date() });
    process.env.PRODUCTION_WORKFLOW_NOTIFY_EMAILS = prev;
    expect(out).toEqual([]);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test("14. SMTP en erreur : l'email n'est jamais marqué SENT", async () => {
    const fakeId = "22222222-2222-4222-8222-222222222222";
    created.fakeRequestIds.push(fakeId);
    mailer.sendMail.mockRejectedValueOnce(Object.assign(new Error("554 5.7.1 rejected"), { responseCode: 554 }));
    const out = await notify.notifyUnarchiveRequestCreated({ id: fakeId, userEmail: PROD2, ficheType: "PROBAR", dateProduction: MISSING_DATE, reason: "x", requestedAt: new Date() });
    expect(out[0].status).toBe("FAILED");
    const row = await EmailQueue.findOne({ where: { dedupeKey: { [Op.like]: `%:${fakeId}:%` } } });
    expect(row.status).toBe("FAILED");
    expect(row.sentAt).toBeNull();
  });
});
