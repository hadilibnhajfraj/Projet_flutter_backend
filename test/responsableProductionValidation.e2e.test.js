"use strict";

// Validation RÉELLE depuis le compte responsable_production@cbi-tunisia.com :
// connexion par POST /auth/signin (vrai mot de passe, lu dans la variable
// d'environnement RESPONSABLE_PRODUCTION_PASSWORD, jamais écrit dans le code ;
// test ignoré si elle est absente), puis décisions avec le JWT obtenu, sur la
// BASE RÉELLE, vraie application Express + Socket.IO. Le responsable
// logistique est connecté en même temps (temps réel, double décision).
// Toutes les données créées sont supprimées en afterAll ; numérotations
// restaurées sans jamais descendre sous un numéro réel. Aucun jeton ni mot de
// passe n'est affiché.

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
const request = require("supertest");
const { io: ioClient } = require("socket.io-client");
const { QueryTypes } = require("sequelize");

const app = require("../src/app");
const socketServer = require("../src/socket");
const { sequelize } = require("../src/db");
const { signAccessToken, verifyAccessToken } = require("../src/utils/tokens");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const PorPromesh = require("../src/models/PorPromesh");
const RawMaterialRequest = require("../src/models/RawMaterialRequest");
const RawHistory = require("../src/models/RawMaterialRequestStatusHistory");
const FicheHistory = require("../src/models/ProductionFicheApprovalHistory");
const rawCfg = require("../src/config/rawMaterialRequest");

const PASSWORD = process.env.RESPONSABLE_PRODUCTION_PASSWORD;
const describeIfPassword = PASSWORD ? describe : describe.skip;

const RESP_PROD = "responsable_production@cbi-tunisia.com";
const RESP_LOG = "responsable_logistique@cbi-tunisia.com";
const PROD1 = "production_1@cbi-tunisia.com";
const FRIDAYS = ["2027-02-05", "2027-02-12"];
const MONDAY = "2027-02-08";
const ITEMS = [
  { material: "ISO", reference: "ISO-VAL", lot: "L-VAL", quantiteDisponible: 5, besoinProduction: 10, quantiteDemandee: 15 },
  { material: "GRAIN_PLASTIQUE", quantiteDisponible: 145, besoinProduction: 1000, quantiteDemandee: 855 },
];

const created = { raw: [], promesh: [] };
const events = { respProd: [], respLog: [] };
const sockets = {};
let server;
let baseUrl;
let respProdToken; // JWT obtenu par la vraie connexion
let respLog;
let prod1;
let seqBefore;

const signed = (u) => signAccessToken({ sub: u.id, email: u.email, role: u.role });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(key, predicate, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = events[key].find(predicate);
    if (hit) return hit;
    await pause(25);
  }
  throw new Error(`Aucun événement temps réel attendu reçu par ${key}`);
}

function listen(key, token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
    for (const ev of ["notification:new", "raw-material-request:updated", "production-fiche-approval:updated"]) {
      s.on(ev, (d) => events[key].push({ ev, ...d }));
    }
    s.on("connect", () => {
      sockets[key] = s;
      resolve();
    });
    s.on("connect_error", reject);
  });
}

async function createRaw(friday) {
  rawCfg.clock = () => new Date(`${friday}T08:00:00Z`);
  const res = await request(app)
    .post("/raw-material-requests")
    .set("Authorization", `Bearer ${signed(prod1)}`)
    .send({ clientRequestId: crypto.randomUUID(), poste: "matin", items: ITEMS });
  if (res.body?.data?.id) created.raw.push(res.body.data.id);
  return res;
}

describeIfPassword("Validation réelle depuis le compte responsable_production", () => {
  beforeAll(async () => {
    respLog = await User.findOne({ where: { email: RESP_LOG }, attributes: ["id", "email", "role"] });
    prod1 = await User.findOne({ where: { email: PROD1 }, attributes: ["id", "email", "role"] });
    const clash = await RawMaterialRequest.count({ where: { requestDate: FRIDAYS } });
    if (clash) throw new Error("Test annulé : une demande réelle existe déjà pour un des vendredis de test.");
    [seqBefore] = await sequelize.query(`SELECT last_value FROM "por_promesh_sequenceNumber_seq"`, { type: QueryTypes.SELECT });

    server = http.createServer(app);
    socketServer.init(server);
    await new Promise((r) => server.listen(0, r));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  afterAll(async () => {
    // Données de test d'abord : l'arrêt du serveur ne doit jamais empêcher le nettoyage.
    rawCfg.clock = () => new Date();
    if (created.raw.length) {
      await Notification.destroy({ where: { rawMaterialRequestId: created.raw } });
      await RawHistory.destroy({ where: { requestId: created.raw } });
      await RawMaterialRequest.destroy({ where: { id: created.raw } });
    }
    if (created.promesh.length) {
      const ids = created.promesh;
      await Notification.destroy({ where: { productionFicheId: ids } });
      await FicheHistory.destroy({ where: { ficheId: ids } });
      for (const t of ["por_promesh_controle_qualite", "por_promesh_arret_machine", "por_promesh_consommation", "por_promesh_process_control", "por_promesh_non_conformite", "por_promesh_attachments"]) {
        await sequelize.query(`DELETE FROM ${t} WHERE "porPromeshId" IN (:ids)`, { replacements: { ids } }).catch(() => {});
      }
      await PorPromesh.destroy({ where: { id: ids } });
    }
    if (seqBefore) {
      const [{ m }] = await sequelize.query(`SELECT COALESCE(MAX("sequenceNumber"), 0) AS m FROM por_promesh`, { type: QueryTypes.SELECT });
      await sequelize.query(`SELECT setval('"por_promesh_sequenceNumber_seq"', :v, true)`, { replacements: { v: Math.max(Number(seqBefore.last_value), Number(m)) } });
    }
    const [{ r }] = await sequelize.query(
      `SELECT COALESCE(MAX(CAST(split_part("requestNumber", '-', 3) AS INTEGER)), 0) AS r FROM raw_material_requests`,
      { type: QueryTypes.SELECT }
    );
    await sequelize.query(`SELECT setval('raw_material_request_number_seq', :v, :called)`, { replacements: { v: Math.max(Number(r), 1), called: Number(r) > 0 } });
    for (const s of Object.values(sockets)) s?.disconnect();
    try {
      socketServer.close(); // ferme aussi le serveur HTTP
    } catch (e) {
      console.warn(`[test] arrêt du serveur : ${e.message}`);
    }
    await sequelize.close();
  }, 30000);

  test("connexion réelle : JWT valide, rôle enregistré renvoyé tel quel, jamais Super Admin", async () => {
    const res = await request(app).post("/auth/signin").send({ email: RESP_PROD, password: PASSWORD });
    expect(res.status).toBe(200);
    respProdToken = res.body.accessToken;
    const payload = verifyAccessToken(respProdToken);
    const dbUser = await User.findOne({ where: { email: RESP_PROD } });
    expect(payload).toMatchObject({ sub: dbUser.id, email: RESP_PROD, role: dbUser.role });
    expect(res.body.user.role).toBe(dbUser.role);
    expect(dbUser.role).toBe(respLog.role); // même rôle que le responsable logistique
    expect(["admin", "superadmin", "superadmin2"]).not.toContain(payload.role);
    await listen("respProd", respProdToken);
    await listen("respLog", signed(respLog));
  });

  test("demande en attente (non traitée par le responsable logistique) : consultée et ACCEPTÉE par le responsable production", async () => {
    const res = await createRaw(FRIDAYS[0]);
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    // Les deux responsables sont notifiés en temps réel.
    for (const who of ["respProd", "respLog"]) await waitFor(who, (e) => e.ev === "notification:new" && e.rawMaterialRequestId === id);

    const auth = { Authorization: `Bearer ${respProdToken}` };
    // Demande complète : toutes les lignes, disponible / besoin / demandé.
    const detail = await request(app).get(`/raw-material-requests/${id}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe("PENDING_VALIDATION");
    expect(detail.body.data.items.map((i) => [i.material, i.quantiteDisponible, i.besoinProduction, i.quantiteDemandee])).toEqual([
      ["ISO", 5, 10, 15],
      ["GRAIN_PLASTIQUE", 145, 1000, 855],
    ]);
    // Dans la liste « demandes à valider ».
    const toProcess = await request(app).get("/raw-material-requests?toProcess=true").set(auth);
    expect(toProcess.body.data.map((r) => r.id)).toContain(id);

    const ok = await request(app).patch(`/raw-material-requests/${id}/status`).set(auth).send({ status: "VALIDATED", expectedStatus: "PENDING_VALIDATION" });
    expect(ok.status).toBe(200);
    const db = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(db).toMatchObject({ status: "VALIDATED", validatedByEmail: RESP_PROD });
    expect(db.validatedAt).toBeInstanceOf(Date);
    // Historique : décideur, date.
    const hist = (await request(app).get(`/raw-material-requests/${id}`).set(auth)).body.data.history;
    expect(hist.at(-1)).toMatchObject({ fromStatus: "PENDING_VALIDATION", toStatus: "VALIDATED", changedByEmail: RESP_PROD });
    // Statut actualisé en temps réel chez le responsable logistique, qui ne peut plus décider.
    await waitFor("respLog", (e) => e.ev === "raw-material-request:updated" && e.id === id && e.status === "VALIDATED");
    const contra = await request(app)
      .patch(`/raw-material-requests/${id}/status`)
      .set("Authorization", `Bearer ${signed(respLog)}`)
      .send({ status: "REJECTED", comment: "Contradictoire", expectedStatus: "PENDING_VALIDATION" });
    expect(contra.status).toBe(409);
    expect((await RawMaterialRequest.findByPk(id)).status).toBe("VALIDATED");
  });

  test("demande en attente : REFUSÉE par le responsable production avec motif obligatoire ; historique et décideur visibles des deux responsables", async () => {
    const res = await createRaw(FRIDAYS[1]);
    const id = res.body.data.id;
    const auth = { Authorization: `Bearer ${respProdToken}` };
    const noReason = await request(app).patch(`/raw-material-requests/${id}/status`).set(auth).send({ status: "REJECTED", expectedStatus: "PENDING_VALIDATION" });
    expect(noReason.status).toBe(400);
    expect((await RawMaterialRequest.findByPk(id)).status).toBe("PENDING_VALIDATION");

    const ko = await request(app)
      .patch(`/raw-material-requests/${id}/status`)
      .set(auth)
      .send({ status: "REJECTED", comment: "Stock GRAIN PLASTIQUE suffisant", expectedStatus: "PENDING_VALIDATION" });
    expect(ko.status).toBe(200);
    for (const token of [respProdToken, signed(respLog)]) {
      const d = (await request(app).get(`/raw-material-requests/${id}`).set("Authorization", `Bearer ${token}`)).body.data;
      expect(d).toMatchObject({ status: "REJECTED", rejectedByEmail: RESP_PROD, rejectionComment: "Stock GRAIN PLASTIQUE suffisant" });
      expect(d.rejectedAt).toBeTruthy();
      expect(d.history.at(-1)).toMatchObject({ toStatus: "REJECTED", changedByEmail: RESP_PROD, comment: "Stock GRAIN PLASTIQUE suffisant" });
    }
    // Compteurs relus : plus aucune demande en attente pour aucun des deux.
    for (const token of [respProdToken, signed(respLog)]) {
      const list = (await request(app).get("/raw-material-requests?toProcess=true").set("Authorization", `Bearer ${token}`)).body.data;
      expect(list.map((r) => r.id)).not.toContain(id);
    }
    // Producteur notifié avec le motif.
    const n = await Notification.findOne({ where: { userId: prod1.id, rawMaterialRequestId: id } });
    expect(n.message).toContain("Motif : « Stock GRAIN PLASTIQUE suffisant »");
  });

  test("fiche de production : acceptée par le responsable production avec le même mécanisme", async () => {
    rawCfg.clock = () => new Date(`${MONDAY}T08:00:00Z`);
    const p = await request(app)
      .post("/por-promesh/new")
      .set("Authorization", `Bearer ${signed(prod1)}`)
      .send({ machine: "1", poste: "matin", dateProduction: MONDAY });
    expect(p.status).toBe(201);
    created.promesh.push(p.body.data.id);
    await waitFor("respProd", (e) => e.ev === "notification:new" && e.productionFicheId === p.body.data.id);
    const auth = { Authorization: `Bearer ${respProdToken}` };
    expect((await request(app).post(`/production-fiche-approvals/promesh/${p.body.data.id}/approve`).set(auth).send({})).status).toBe(200);
    expect(await PorPromesh.findByPk(p.body.data.id, { raw: true })).toMatchObject({ approvalStatus: "APPROVED", approvalDecidedByEmail: RESP_PROD });
    await waitFor("respLog", (e) => e.ev === "production-fiche-approval:updated" && e.id === p.body.data.id && e.status === "APPROVED");
    expect((await request(app).post(`/production-fiche-approvals/promesh/${p.body.data.id}/reject`).set("Authorization", `Bearer ${signed(respLog)}`).send({ comment: "x" })).status).toBe(409);
  });
});

if (!PASSWORD) {
  test.skip("RESPONSABLE_PRODUCTION_PASSWORD absent : validation réelle non exécutée", () => {});
}
