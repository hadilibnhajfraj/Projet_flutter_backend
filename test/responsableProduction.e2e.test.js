"use strict";

// responsable_production@cbi-tunisia.com : mêmes droits et fonctionnalités
// que responsable_logistique@cbi-tunisia.com — bout en bout, BASE RÉELLE,
// vrai serveur HTTP + Socket.IO (connexions WebSocket authentifiées).
//
// Le compte n'existant pas encore en base, le test le crée TEMPORAIREMENT
// (même rôle réel que le responsable logistique : responsable_logistique_achat,
// mot de passe aléatoire inutilisable) puis le supprime avec toutes les
// données du test. S'il existe déjà, il est utilisé tel quel, jamais modifié.
// Emails : file simulée. Toutes les données créées sont supprimées en
// afterAll ; les numérotations sont restaurées sans jamais descendre sous un
// numéro réel.

process.env.PRODUCTION_COMPLIANCE_ENABLED = "false";

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test", accepted: [], rejected: [], response: "250 OK" }),
  verifyConnection: jest.fn().mockResolvedValue({ ok: true }),
  maskEmail: (e) => e,
}));
jest.mock("../src/services/emailQueue.service", () => ({
  ...jest.requireActual("../src/services/emailQueue.service"),
  enqueueEmailOnce: jest.fn().mockResolvedValue({ jobId: null, status: "MOCK", duplicate: false }),
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));

const http = require("http");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const request = require("supertest");
const { io: ioClient } = require("socket.io-client");
const { Op, QueryTypes } = require("sequelize");

const app = require("../src/app");
const socketServer = require("../src/socket");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const PorPromesh = require("../src/models/PorPromesh");
const IndustrialRecord = require("../src/models/IndustrialRecord");
const RawMaterialRequest = require("../src/models/RawMaterialRequest");
const RawHistory = require("../src/models/RawMaterialRequestStatusHistory");
const FicheHistory = require("../src/models/ProductionFicheApprovalHistory");
const rawCfg = require("../src/config/rawMaterialRequest");
const ficheCfg = require("../src/config/productionFicheApproval");
const workflowCfg = require("../src/config/productionWorkflow");
const { isMaintenanceRequester } = require("../src/config/maintenanceRequester");

const EMAILS = {
  respProd: "responsable_production@cbi-tunisia.com",
  respLog: "responsable_logistique@cbi-tunisia.com",
  prod1: "production_1@cbi-tunisia.com",
  prod2: "production_2@cbi-tunisia.com",
  prod3: "production_3@cbi-tunisia.com",
};
const FRIDAYS = ["2027-01-15", "2027-01-22", "2027-01-29"];
const MONDAY = "2027-01-18";
const START = new Date();

const users = {};
const sockets = {};
const events = {};
const created = { raw: [], promesh: [], probar: [] };
let tempUserCreated = false;
let server;
let baseUrl;
let seqBefore;

const token = (u) => signAccessToken({ sub: u.id, email: u.email, role: u.role });
const api = (method, path, who) => request(app)[method](path).set("Authorization", `Bearer ${token(users[who])}`);
const at = (iso) => {
  rawCfg.clock = () => new Date(iso);
};
const ITEMS = [
  { material: "ISO", quantiteDisponible: 5, besoinProduction: 10, quantiteDemandee: 15 },
  { material: "FIBRE", quantiteDisponible: 15, besoinProduction: 14, quantiteDemandee: 25 },
];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(key) {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth: { token: token(users[key]) }, transports: ["websocket"], reconnection: false, forceNew: true });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

async function listen(key) {
  events[key] = [];
  sockets[key] = await connect(key);
  for (const ev of ["notification:new", "production-fiche-approval:updated", "raw-material-request:updated"]) {
    sockets[key].on(ev, (d) => events[key].push({ ev, ...d }));
  }
}

async function waitFor(key, predicate, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = events[key].find(predicate);
    if (hit) return hit;
    await pause(25);
  }
  throw new Error(`Aucun événement temps réel attendu reçu par ${key}`);
}

async function createRaw(friday) {
  at(`${friday}T08:00:00Z`);
  const res = await api("post", "/raw-material-requests", "prod1").send({ clientRequestId: crypto.randomUUID(), poste: "matin", items: ITEMS });
  if (res.body?.data?.id) created.raw.push(res.body.data.id);
  return res;
}

beforeAll(async () => {
  let rp = await User.findOne({ where: { email: EMAILS.respProd }, attributes: ["id", "email", "role"] });
  if (!rp) {
    rp = await User.create({
      email: EMAILS.respProd,
      role: "responsable_logistique_achat",
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10), // inutilisable
      isActive: true,
    });
    tempUserCreated = true;
  }
  users.respProd = { id: rp.id, email: rp.email, role: rp.role };
  for (const [k, email] of Object.entries(EMAILS)) {
    if (k === "respProd") continue;
    const u = await User.findOne({ where: { email }, attributes: ["id", "email", "role"] });
    if (!u) throw new Error(`Compte introuvable en base : ${email}`);
    users[k] = { id: u.id, email: u.email, role: u.role };
  }
  // Même rôle réel que le compte de référence (aucun nouveau rôle, jamais Super Admin).
  expect(users.respProd.role).toBe(users.respLog.role);
  expect(users.respProd.role).toBe("responsable_logistique_achat");

  const clash = await RawMaterialRequest.count({ where: { requestDate: FRIDAYS } });
  if (clash) throw new Error("Test annulé : une demande réelle existe déjà pour un des vendredis de test.");
  [seqBefore] = await sequelize.query(`SELECT last_value FROM "por_promesh_sequenceNumber_seq"`, { type: QueryTypes.SELECT });

  server = http.createServer(app);
  socketServer.init(server);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://localhost:${server.address().port}`;
  for (const k of ["respProd", "respLog", "prod1", "prod2", "prod3"]) await listen(k);
});

afterAll(async () => {
  try {
    for (const s of Object.values(sockets)) s?.disconnect();
    socketServer.close();
    if (server?.listening) await new Promise((r) => server.close(() => r()));
  } catch (e) {
    console.warn(`[test] arrêt du serveur : ${e.message}`);
  }
  rawCfg.clock = () => new Date();

  if (created.raw.length) {
    await Notification.destroy({ where: { rawMaterialRequestId: created.raw } });
    await RawHistory.destroy({ where: { requestId: created.raw } });
    await RawMaterialRequest.destroy({ where: { id: created.raw } });
  }
  const fiches = [...created.promesh, ...created.probar];
  if (fiches.length) {
    await Notification.destroy({ where: { productionFicheId: fiches } });
    await FicheHistory.destroy({ where: { ficheId: fiches } });
    await PorPromesh.destroy({ where: { id: created.promesh } });
    await IndustrialRecord.destroy({ where: { id: created.probar } });
  }
  if (tempUserCreated) {
    await Notification.destroy({ where: { userId: users.respProd.id } });
    await User.destroy({ where: { id: users.respProd.id, email: EMAILS.respProd } });
  }
  const [{ m }] = await sequelize.query(`SELECT COALESCE(MAX("sequenceNumber"), 0) AS m FROM por_promesh`, { type: QueryTypes.SELECT });
  await sequelize.query(`SELECT setval('"por_promesh_sequenceNumber_seq"', :v, true)`, { replacements: { v: Math.max(Number(seqBefore.last_value), Number(m)) } });
  const [{ r }] = await sequelize.query(
    `SELECT COALESCE(MAX(CAST(split_part("requestNumber", '-', 3) AS INTEGER)), 0) AS r FROM raw_material_requests`,
    { type: QueryTypes.SELECT }
  );
  await sequelize.query(`SELECT setval('raw_material_request_number_seq', :v, :called)`, { replacements: { v: Math.max(Number(r), 1), called: Number(r) > 0 } });
  await sequelize.close();
});

describe("Mêmes droits que le responsable logistique (API)", () => {
  test("liste centrale : les deux responsables, ni production_1..5 ni Super Admin", () => {
    for (const email of [EMAILS.respProd, EMAILS.respLog]) {
      expect(ficheCfg.isValidator(email)).toBe(true);
      expect(rawCfg.validators).toContain(email);
      expect(rawCfg.managers).toContain(email);
      expect(workflowCfg.emailPermissions(email)).toHaveLength(7);
      expect(isMaintenanceRequester(email)).toBe(true);
    }
    for (const email of [EMAILS.prod1, EMAILS.prod2, EMAILS.prod3, "cbitunisia@cbi-tunisia.com"]) {
      expect(ficheCfg.isValidator(email)).toBe(false);
      expect(rawCfg.validators).not.toContain(email);
      expect(workflowCfg.emailPermissions(email)).toHaveLength(0);
      expect(isMaintenanceRequester(email)).toBe(false);
    }
  });

  test("permissions renvoyées par les API : identiques pour les deux responsables", async () => {
    for (const path of ["/production-fiche-approvals/permissions", "/raw-material-requests/permissions"]) {
      const a = await api("get", path, "respProd");
      const b = await api("get", path, "respLog");
      expect(a.status).toBe(200);
      expect(a.body.data).toEqual(b.body.data);
    }
    expect((await api("get", "/production-fiche-approvals/permissions", "respProd")).body.data).toMatchObject({ canDecide: true, canViewAll: true });
    expect((await api("get", "/raw-material-requests/permissions", "respProd")).body.data).toMatchObject({ canValidate: true });
    // production_3 (même rôle) : toujours aucun droit.
    expect((await api("get", "/production-fiche-approvals/permissions", "prod3")).body.data.canDecide).toBe(false);
  });

  test("demandes Production (rattrapage / désarchivage) et statistiques : mêmes accès", async () => {
    for (const path of ["/production-compliance/requests", "/production-compliance/requests/stats"]) {
      expect((await api("get", path, "respProd")).status).toBe(200);
      expect((await api("get", path, "respLog")).status).toBe(200);
      expect((await api("get", path, "prod3")).status).toBe(403);
    }
    // Écrans du module industriel communs au rôle : mêmes réponses.
    for (const path of ["/production-fiche-approvals/summary", "/raw-material-requests/pending-summary"]) {
      const a = await api("get", path, "respProd");
      const b = await api("get", path, "respLog");
      expect(a.status).toBe(200);
      expect(a.body.data).toEqual(b.body.data);
    }
  });
});

describe("Fiches de production", () => {
  test("création : les deux responsables sont notifiés en temps réel", async () => {
    at(`${MONDAY}T08:00:00Z`);
    const p = await api("post", "/por-promesh/new", "prod1").send({ machine: "1", poste: "matin", dateProduction: MONDAY });
    expect(p.status).toBe(201);
    created.promesh.push(p.body.data.id);
    const b = await api("post", "/industrial-records", "prod2").send({ module: "probar", machine: "3", poste: "nuit", dateFiche: MONDAY, quantiteProduite: 90, statut: "enregistree" });
    expect(b.status).toBe(201);
    created.probar.push(b.body.data.id);
    for (const who of ["respProd", "respLog"]) {
      for (const id of [p.body.data.id, b.body.data.id]) {
        await waitFor(who, (e) => e.ev === "notification:new" && e.productionFicheId === id);
        await waitFor(who, (e) => e.ev === "production-fiche-approval:updated" && e.id === id);
      }
    }
    // Visible dans la liste « en attente » des deux.
    for (const who of ["respProd", "respLog"]) {
      const list = (await api("get", "/production-fiche-approvals?status=PENDING", who)).body.data.map((i) => i.id);
      expect(list).toEqual(expect.arrayContaining([p.body.data.id, b.body.data.id]));
    }
  });

  test("acceptation par le responsable production : enregistrée à son nom ; l'autre responsable est prévenu et ne peut plus décider", async () => {
    const [pid] = created.promesh;
    const before = events.respLog.length;
    const res = await api("post", `/production-fiche-approvals/promesh/${pid}/approve`, "respProd").send({});
    expect(res.status).toBe(200);
    const db = await PorPromesh.findByPk(pid, { raw: true });
    expect(db).toMatchObject({ approvalStatus: "APPROVED", approvalDecidedBy: users.respProd.id, approvalDecidedByEmail: EMAILS.respProd });
    expect(db.approvalDecidedAt).toBeInstanceOf(Date);
    const h = await FicheHistory.findOne({ where: { ficheId: pid, toStatus: "APPROVED" } });
    expect(h.changedByEmail).toBe(EMAILS.respProd);
    // Interface du responsable logistique actualisée en temps réel.
    await waitFor("respLog", (e) => e.ev === "production-fiche-approval:updated" && e.id === pid && e.status === "APPROVED");
    expect(events.respLog.length).toBeGreaterThan(before);
    // Seconde décision refusée par le backend.
    const again = await api("post", `/production-fiche-approvals/promesh/${pid}/reject`, "respLog").send({ comment: "Trop tard" });
    expect(again.status).toBe(409);
    expect((await PorPromesh.findByPk(pid)).approvalStatus).toBe("APPROVED");
    // Producteur notifié.
    const n = await waitFor("prod1", (e) => e.ev === "notification:new" && e.productionFicheId === pid);
    expect(n.title).toBe("Votre fiche de production a été validée");
    expect(n.message).toContain(EMAILS.respProd);
  });

  test("refus par le responsable production : motif obligatoire, puis motif enregistré et transmis", async () => {
    const [bid] = created.probar;
    expect((await api("post", `/production-fiche-approvals/probar/${bid}/reject`, "respProd").send({ comment: " " })).status).toBe(400);
    const res = await api("post", `/production-fiche-approvals/probar/${bid}/reject`, "respProd").send({ comment: "Rendement incohérent" });
    expect(res.status).toBe(200);
    const db = await IndustrialRecord.findByPk(bid, { raw: true });
    expect(db).toMatchObject({ approvalStatus: "REJECTED", approvalDecidedByEmail: EMAILS.respProd, approvalRejectionComment: "Rendement incohérent" });
    const n = await waitFor("prod2", (e) => e.ev === "notification:new" && e.productionFicheId === bid);
    expect(n.message).toContain("Motif : Rendement incohérent");
    // Historique consultable par les deux responsables.
    for (const who of ["respProd", "respLog"]) {
      const d = (await api("get", `/production-fiche-approvals/probar/${bid}`, who)).body.data;
      expect(d.history.map((x) => [x.toStatus, x.changedByEmail])).toContainEqual(["REJECTED", EMAILS.respProd]);
    }
  });
});

describe("Demandes de matières premières", () => {
  test("création : les deux responsables notifiés ; validation par le responsable production à son nom ; seconde décision refusée", async () => {
    const res = await createRaw(FRIDAYS[0]);
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    for (const who of ["respProd", "respLog"]) await waitFor(who, (e) => e.ev === "notification:new" && e.rawMaterialRequestId === id);

    const v = await api("patch", `/raw-material-requests/${id}/status`, "respProd").send({ status: "VALIDATED" });
    expect(v.status).toBe(200);
    const db = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(db).toMatchObject({ status: "VALIDATED", validatedBy: users.respProd.id, validatedByEmail: EMAILS.respProd });
    await waitFor("respLog", (e) => e.ev === "raw-material-request:updated" && e.id === id && e.status === "VALIDATED");
    // Seconde décision de l'autre responsable sur la demande « en attente »
    // qu'il avait affichée : refusée (409), quelle que soit la décision.
    for (const status of ["VALIDATED", "REJECTED"]) {
      const again = await api("patch", `/raw-material-requests/${id}/status`, "respLog").send({ status, comment: "Trop tard", expectedStatus: "PENDING_VALIDATION" });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("STATUS_CHANGED_CONCURRENTLY");
    }
    const db2 = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(db2).toMatchObject({ status: "VALIDATED", validatedByEmail: EMAILS.respProd });
    const n = await waitFor("prod1", (e) => e.ev === "notification:new" && e.rawMaterialRequestId === id);
    expect(n.message).toContain(`validée par ${EMAILS.respProd}`);
  });

  test("décisions simultanées des deux responsables sur une demande en attente : une seule aboutit", async () => {
    const res = await createRaw(FRIDAYS[2]);
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    const [a, b] = await Promise.all([
      api("patch", `/raw-material-requests/${id}/status`, "respProd").send({ status: "VALIDATED", expectedStatus: "PENDING_VALIDATION" }),
      api("patch", `/raw-material-requests/${id}/status`, "respLog").send({ status: "REJECTED", comment: "Simultané", expectedStatus: "PENDING_VALIDATION" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const hist = await RawHistory.findAll({ where: { requestId: id, fromStatus: "PENDING_VALIDATION" }, raw: true });
    expect(hist).toHaveLength(1);
    // La décision enregistrée est celle qui a abouti, jamais écrasée.
    const winner = a.status === 200 ? ["VALIDATED", EMAILS.respProd] : ["REJECTED", EMAILS.respLog];
    expect([(await RawMaterialRequest.findByPk(id)).status, hist[0].changedByEmail]).toEqual(winner);
  });

  test("refus par le responsable production avec motif ; le responsable logistique fonctionne toujours", async () => {
    const res = await createRaw(FRIDAYS[1]);
    const id = res.body.data.id;
    expect((await api("patch", `/raw-material-requests/${id}/status`, "respProd").send({ status: "REJECTED" })).status).toBe(400);
    const r = await api("patch", `/raw-material-requests/${id}/status`, "respProd").send({ status: "REJECTED", comment: "Quantité FIBRE à revoir" });
    expect(r.status).toBe(200);
    const db = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(db).toMatchObject({ status: "REJECTED", rejectedByEmail: EMAILS.respProd, rejectionComment: "Quantité FIBRE à revoir" });
    const hist = await RawHistory.findAll({ where: { requestId: id }, order: [["createdAt", "ASC"]], raw: true });
    expect(hist.at(-1)).toMatchObject({ toStatus: "REJECTED", changedByEmail: EMAILS.respProd, comment: "Quantité FIBRE à revoir" });

    // Le responsable logistique : liste, détail et historique toujours accessibles.
    const list = await api("get", "/raw-material-requests?pageSize=50", "respLog");
    expect(list.status).toBe(200);
    expect(list.body.data.map((x) => x.id)).toContain(id);
    expect((await api("get", `/raw-material-requests/${id}`, "respLog")).status).toBe(200);
  });

  test("notifications : historique du responsable production, et rien pour production_3", async () => {
    const mine = await api("get", "/notifications?limit=50", "respProd");
    expect(mine.status).toBe(200);
    expect(mine.body.items.filter((i) => created.raw.includes(i.rawMaterialRequestId)).length).toBeGreaterThanOrEqual(2);
    expect(mine.body.items.filter((i) => [...created.promesh, ...created.probar].includes(i.productionFicheId)).length).toBe(2);
    expect(mine.body.items.every((i) => i.userId === users.respProd.id)).toBe(true);
    expect(events.prod3).toEqual([]);
    await pause(100);
    expect(await Notification.count({ where: { userId: users.prod3.id, createdAt: { [Op.gte]: START } } })).toBe(0);
  });
});
