"use strict";

// Notifications en temps réel — bout en bout, BASE RÉELLE, comptes réels,
// vrai serveur HTTP + Socket.IO (connexions WebSocket authentifiées) :
//   - demandes de matières premières : création → responsable logistique ;
//     validation / rejet → le bon producteur ;
//   - fiches de production : création → responsable ; décision → producteur ;
//   - connexions sans jeton refusées, aucune écoute des notifications d'un
//     autre utilisateur, aucune notification pour une écriture annulée,
//     aucun doublon, notifications conservées après déconnexion.
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
const ficheApproval = require("../src/modules/production-fiche-approvals/services/ficheApproval.service");
const rawCfg = require("../src/config/rawMaterialRequest");

const EMAILS = {
  prod1: "production_1@cbi-tunisia.com",
  prod2: "production_2@cbi-tunisia.com",
  prod3: "production_3@cbi-tunisia.com",
  validator: "responsable_logistique@cbi-tunisia.com",
};
// Vendredis sans demande réelle (vérifié en beforeAll), 9 h à Tunis.
const FRIDAYS = ["2026-12-04", "2026-12-11", "2026-12-18", "2027-01-08"];
const MONDAY = "2026-12-07";
const START = new Date();

const users = {};
const sockets = {};
const events = {}; // email-key → notifications reçues en temps réel
const created = { raw: [], promesh: [], probar: [] };
let server;
let baseUrl;
let seqBefore;
let rawSeqBefore;

const token = (u) => signAccessToken({ sub: u.id, email: u.email, role: u.role });
const api = (method, path, who) => request(app)[method](path).set("Authorization", `Bearer ${token(users[who])}`);
const at = (iso) => {
  rawCfg.clock = () => new Date(iso);
};
const ITEMS = [
  { material: "ISO", quantiteDisponible: 5, besoinProduction: 10, quantiteDemandee: 15 },
  { material: "RESINE", quantiteDisponible: 10, besoinProduction: 25, quantiteDemandee: 15 },
];

function connect(key, auth = { token: token(users[key]) }) {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth, transports: ["websocket"], reconnection: false, forceNew: true });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
  });
}

async function listen(key) {
  events[key] = events[key] || [];
  sockets[key] = await connect(key);
  sockets[key].on("notification:new", (n) => events[key].push(n));
}

/** Attend une notification temps réel correspondant au prédicat (ou échoue). */
async function waitFor(key, predicate, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = events[key].find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Aucune notification temps réel reçue par ${key} dans les ${timeout} ms`);
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const received = (key, predicate) => events[key].filter(predicate);

async function createRaw(who, friday, poste = "matin") {
  at(`${friday}T08:00:00Z`);
  const res = await api("post", "/raw-material-requests", who).send({ clientRequestId: crypto.randomUUID(), poste, items: ITEMS });
  if (res.body?.data?.id) created.raw.push(res.body.data.id);
  return res;
}

beforeAll(async () => {
  for (const [k, email] of Object.entries(EMAILS)) {
    const u = await User.findOne({ where: { email }, attributes: ["id", "email", "role"] });
    if (!u) throw new Error(`Compte introuvable en base : ${email}`);
    users[k] = { id: u.id, email: u.email, role: u.role };
  }
  const clash = await RawMaterialRequest.count({ where: { requestDate: FRIDAYS } });
  if (clash) throw new Error("Test annulé : une demande réelle existe déjà pour un des vendredis de test.");
  [seqBefore] = await sequelize.query(`SELECT last_value FROM "por_promesh_sequenceNumber_seq"`, { type: QueryTypes.SELECT });
  [rawSeqBefore] = await sequelize.query(`SELECT last_value FROM raw_material_request_number_seq`, { type: QueryTypes.SELECT });

  server = http.createServer(app);
  socketServer.init(server);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://localhost:${server.address().port}`;
  for (const k of Object.keys(EMAILS)) await listen(k);
});

afterAll(async () => {
  // Arrêt des connexions et du serveur : un échec ici ne doit jamais empêcher
  // le nettoyage des données (Socket.IO ferme aussi le serveur HTTP).
  try {
    for (const s of Object.values(sockets)) s?.disconnect();
    socketServer.close();
    if (server?.listening) await new Promise((r) => server.close(() => r()));
  } catch (e) {
    console.warn(`[test] arrêt du serveur : ${e.message}`);
  }
  rawCfg.clock = () => new Date();
  delete process.env.RAW_MATERIAL_REQUEST_EMAILS;
  delete process.env.RAW_MATERIAL_REQUEST_POSTES;

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
  await Notification.destroy({ where: { type: "TEST_REALTIME", createdAt: { [Op.gte]: START } } });

  // Numérotations : jamais sous un numéro réel.
  const [{ m }] = await sequelize.query(`SELECT COALESCE(MAX("sequenceNumber"), 0) AS m FROM por_promesh`, { type: QueryTypes.SELECT });
  await sequelize.query(`SELECT setval('"por_promesh_sequenceNumber_seq"', :v, true)`, { replacements: { v: Math.max(Number(seqBefore.last_value), Number(m)) } });
  const [{ r }] = await sequelize.query(
    `SELECT COALESCE(MAX(CAST(split_part("requestNumber", '-', 3) AS INTEGER)), 0) AS r FROM raw_material_requests`,
    { type: QueryTypes.SELECT }
  );
  const rawRestore = Math.max(Number(r), 1);
  await sequelize.query(`SELECT setval('raw_material_request_number_seq', :v, :called)`, { replacements: { v: rawRestore, called: Number(r) > 0 } });
  await sequelize.close();
});

describe("Connexions temps réel authentifiées et cloisonnées", () => {
  test("sans jeton ou avec un jeton invalide : connexion refusée", async () => {
    await expect(connect("prod1", {})).rejects.toThrow("UNAUTHORIZED");
    await expect(connect("prod1", { token: "jeton-invalide" })).rejects.toThrow("UNAUTHORIZED");
  });

  test("un utilisateur ne peut pas rejoindre la salle d'un autre (ni « admins »)", async () => {
    sockets.prod3.emit("join", `user:${users.validator.id}`);
    sockets.prod3.emit("join", users.validator.id);
    sockets.prod3.emit("join", "admins");
    await pause(200);
    // Vérifié par les scénarios suivants : prod3 ne reçoit jamais rien.
    expect(events.prod3).toEqual([]);
  });
});

describe("Demandes de matières premières", () => {
  test("1. PROD1 crée une demande : le responsable est notifié immédiatement, avec le contenu complet", async () => {
    const res = await createRaw("prod1", FRIDAYS[0]);
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    const n = await waitFor("validator", (e) => e.rawMaterialRequestId === id);
    expect(n.id).toBeTruthy(); // identifiant persistant (notification en base)
    expect(await Notification.findByPk(n.id)).not.toBeNull();
    for (const part of [res.body.data.requestNumber, `Producteur : ${EMAILS.prod1}`, "Poste : Matin", "Date : 04/12/2026", "Matières : ISO 15 KG, RESINE 15 KG", "Statut : En attente"]) {
      expect(n.message).toContain(part);
    }
    await pause(150);
    for (const k of ["prod1", "prod2", "prod3"]) expect(received(k, (e) => e.rawMaterialRequestId === id)).toEqual([]);
  });

  test("2. PROD2 crée une demande (règle étendue à production_2 / poste Soir pour ce test) : le responsable est notifié", async () => {
    process.env.RAW_MATERIAL_REQUEST_EMAILS = `${EMAILS.prod1},${EMAILS.prod2}`;
    process.env.RAW_MATERIAL_REQUEST_POSTES = "matin,nuit";
    const res = await createRaw("prod2", FRIDAYS[1], "nuit");
    expect(res.status).toBe(201);
    const n = await waitFor("validator", (e) => e.rawMaterialRequestId === res.body.data.id);
    expect(n.message).toContain(`Producteur : ${EMAILS.prod2}`);
    expect(n.message).toContain("Poste : Soir");
    delete process.env.RAW_MATERIAL_REQUEST_EMAILS;
    delete process.env.RAW_MATERIAL_REQUEST_POSTES;
  });

  test("3. validation puis rejet : chaque producteur reçoit sa décision, et elle seule", async () => {
    const [id1, id2] = created.raw;
    const v = await api("patch", `/raw-material-requests/${id1}/status`, "validator").send({ status: "VALIDATED" });
    expect(v.status).toBe(200);
    const ok = await waitFor("prod1", (e) => e.rawMaterialRequestId === id1);
    expect(ok.title).toBe("Demande de matières premières validée");
    expect(ok.message).toContain(`validée par ${EMAILS.validator} le `);

    const r = await api("patch", `/raw-material-requests/${id2}/status`, "validator").send({ status: "REJECTED", comment: "Quantité ISO à revoir" });
    expect(r.status).toBe(200);
    const ko = await waitFor("prod2", (e) => e.rawMaterialRequestId === id2);
    expect(ko.title).toBe("Demande de matières premières rejetée");
    expect(ko.message).toContain("Motif : « Quantité ISO à revoir »");
    await pause(150);
    expect(received("prod1", (e) => e.rawMaterialRequestId === id2)).toEqual([]);
    expect(received("prod2", (e) => e.rawMaterialRequestId === id1)).toEqual([]);
    expect(received("prod3", () => true)).toEqual([]);
  });

  test("rejet sans motif : refusé, aucune notification émise", async () => {
    const res = await createRaw("prod1", FRIDAYS[2]);
    const id = res.body.data.id;
    await waitFor("validator", (e) => e.rawMaterialRequestId === id);
    const before = events.prod1.length;
    const r = await api("patch", `/raw-material-requests/${id}/status`, "validator").send({ status: "REJECTED" });
    expect(r.status).toBe(400);
    await pause(300);
    expect(events.prod1.length).toBe(before);
  });

  test("double clic (même clientRequestId) : une seule demande, une seule notification", async () => {
    at(`${FRIDAYS[3]}T08:00:00Z`);
    const body = { clientRequestId: crypto.randomUUID(), poste: "matin", items: ITEMS };
    const [a, b] = await Promise.all([
      api("post", "/raw-material-requests", "prod1").send(body),
      api("post", "/raw-material-requests", "prod1").send(body),
    ]);
    const id = a.body.data.id;
    for (const x of [a, b]) if (x.body?.data?.id && !created.raw.includes(x.body.data.id)) created.raw.push(x.body.data.id);
    expect(b.body.data.id).toBe(id);
    await waitFor("validator", (e) => e.rawMaterialRequestId === id);
    await pause(400);
    expect(received("validator", (e) => e.rawMaterialRequestId === id)).toHaveLength(1);
    expect(await Notification.count({ where: { userId: users.validator.id, rawMaterialRequestId: id } })).toBe(1);
  });
});

describe("Fiches de production", () => {
  test("4. PROD1 et PROD2 créent une fiche : le responsable est notifié en temps réel", async () => {
    at(`${MONDAY}T08:00:00Z`); // pas de demande de matières premières exigée
    const p = await api("post", "/por-promesh/new", "prod1").send({ machine: "1", poste: "matin", dateProduction: MONDAY });
    expect(p.status).toBe(201);
    created.promesh.push(p.body.data.id);
    const np = await waitFor("validator", (e) => e.productionFicheId === p.body.data.id);
    expect(np).toMatchObject({ type: "PRODUCTION_FICHE_PENDING", productionFicheType: "promesh" });
    for (const part of ["Type de production : PROMESH", "Machine : 1", "Date de production : 07/12/2026", "Poste : Matin", `Producteur : ${EMAILS.prod1}`, "Statut : En attente de validation"]) {
      expect(np.message).toContain(part);
    }

    const b = await api("post", "/industrial-records", "prod2").send({ module: "probar", machine: "2", poste: "nuit", dateFiche: MONDAY, quantiteProduite: 120, statut: "enregistree" });
    expect(b.status).toBe(201);
    created.probar.push(b.body.data.id);
    const nb = await waitFor("validator", (e) => e.productionFicheId === b.body.data.id);
    expect(nb.message).toContain("Type de production : PROBAR");
    expect(nb.message).toContain("Poste : Soir");
    await pause(150);
    expect(received("prod3", () => true)).toEqual([]);
  });

  test("5. acceptation et refus : le producteur reçoit immédiatement la décision et le motif", async () => {
    const [pid] = created.promesh;
    const [bid] = created.probar;
    expect((await api("post", `/production-fiche-approvals/promesh/${pid}/approve`, "validator").send({})).status).toBe(200);
    const ok = await waitFor("prod1", (e) => e.productionFicheId === pid);
    expect(ok.title).toBe("Votre fiche de production a été validée");

    expect((await api("post", `/production-fiche-approvals/probar/${bid}/reject`, "validator").send({ comment: "Rendement à recompter" })).status).toBe(200);
    const ko = await waitFor("prod2", (e) => e.productionFicheId === bid);
    expect(ko.title).toBe("Votre fiche de production a été refusée");
    expect(ko.message).toContain("Motif : Rendement à recompter");
    await pause(150);
    expect(received("prod2", (e) => e.productionFicheId === pid)).toEqual([]);
    expect(received("prod1", (e) => e.productionFicheId === bid)).toEqual([]);
    // Décision enregistrée dans l'historique du module.
    expect(await FicheHistory.count({ where: { ficheId: bid, toStatus: "REJECTED" } })).toBe(1);
  });

  test("10. aucune notification en double lors d'une nouvelle tentative", async () => {
    const [pid] = created.promesh;
    const before = received("validator", (e) => e.productionFicheId === pid).length;
    const fiche = await PorPromesh.findByPk(pid);
    await ficheApproval.notifyCreated("promesh", fiche);
    await ficheApproval.notifyCreated("promesh", fiche);
    await pause(400);
    expect(received("validator", (e) => e.productionFicheId === pid)).toHaveLength(before);
  });
});

describe("Durabilité, intégrité et cloisonnement", () => {
  test("7. notification reçue hors connexion : disponible à la reconnexion (non lue)", async () => {
    sockets.prod1.disconnect();
    at(`${MONDAY}T08:00:00Z`);
    const p = await api("post", "/por-promesh/new", "prod1").send({ machine: "2", poste: "matin", dateProduction: MONDAY });
    created.promesh.push(p.body.data.id);
    await api("post", `/production-fiche-approvals/promesh/${p.body.data.id}/reject`, "validator").send({ comment: "Fiche vide" });

    await listen("prod1"); // reconnexion
    const list = await api("get", "/notifications?limit=20", "prod1");
    expect(list.status).toBe(200);
    const n = list.body.items.find((i) => i.productionFicheId === p.body.data.id);
    expect(n).toMatchObject({ isRead: false, title: "Votre fiche de production a été refusée" });
    expect(list.body.unreadCount).toBeGreaterThanOrEqual(1);

    // Marquer comme lue conserve l'historique.
    expect((await api("put", `/notifications/${n.id}/read`, "prod1")).status).toBe(200);
    expect((await Notification.findByPk(n.id)).isRead).toBe(true);
  });

  test("8. un utilisateur ne voit ni ne modifie les notifications d'un autre", async () => {
    const own = await Notification.findOne({ where: { userId: users.validator.id, productionFicheId: created.promesh[0] } });
    const p3 = await api("get", "/notifications?limit=100", "prod3");
    expect(p3.status).toBe(200);
    expect(p3.body.items.some((i) => i.userId !== users.prod3.id)).toBe(false);
    await api("put", `/notifications/${own.id}/read`, "prod3");
    await api("delete", `/notifications/${own.id}`, "prod3");
    const still = await Notification.findByPk(own.id);
    expect(still).not.toBeNull();
    expect(still.isRead).toBe(false);
    expect(received("prod3", () => true)).toEqual([]);
  });

  test("9. écriture annulée en base : aucune notification émise", async () => {
    const before = events.validator.length;
    await expect(
      sequelize.transaction(async (transaction) => {
        await Notification.create({ userId: users.validator.id, type: "TEST_REALTIME", title: "annulée", message: "annulée" }, { transaction });
        throw new Error("échec simulé après l'écriture");
      })
    ).rejects.toThrow("échec simulé");
    // Doublon refusé par l'index unique : rien non plus.
    await expect(
      Notification.create({
        userId: users.validator.id,
        type: "PRODUCTION_FICHE_PENDING",
        title: "doublon",
        message: "doublon",
        productionFicheType: "promesh",
        productionFicheId: created.promesh[0],
        productionFicheVersion: 1,
      })
    ).rejects.toThrow();
    await pause(400);
    expect(events.validator.length).toBe(before);
    expect(await Notification.count({ where: { type: "TEST_REALTIME" } })).toBe(0);

    // Écriture validée dans une transaction : émise seulement après le commit.
    await sequelize.transaction(async (transaction) => {
      await Notification.create({ userId: users.validator.id, type: "TEST_REALTIME", title: "validée", message: "validée" }, { transaction });
      await pause(200);
      expect(received("validator", (e) => e.type === "TEST_REALTIME")).toEqual([]); // pas encore validée
    });
    await waitFor("validator", (e) => e.type === "TEST_REALTIME");
  });
});
