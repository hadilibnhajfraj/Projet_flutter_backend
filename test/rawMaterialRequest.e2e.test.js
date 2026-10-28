"use strict";

// Bout en bout, BASE RÉELLE, comptes réels : production_1 crée une demande
// de matières premières (horloge serveur fixée à un vendredi), le
// responsable logistique la voit dans les demandes à valider, consulte son
// détail, la valide ; une 2e demande est rejetée (motif obligatoire). Les
// décisions persistent après « reconnexion » (nouveaux jetons).
// Vraie application Express (auth, moduleAccessGuard, requireRole, routes).
// Aucun email réel (file d'emails simulée). Toutes les données créées sont
// supprimées en afterAll ; la demande existante DMP-2026-000001 n'est jamais
// modifiée (vérifié) et la séquence des numéros est restaurée.

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

const request = require("supertest");
const { Op, QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const RawMaterialRequest = require("../src/models/RawMaterialRequest");
const History = require("../src/models/RawMaterialRequestStatusHistory");
const { enqueueEmailOnce } = require("../src/services/emailQueue.service");
const cfg = require("../src/config/rawMaterialRequest");

const PROD1 = "production_1@cbi-tunisia.com";
const PROD2 = "production_2@cbi-tunisia.com";
const VALIDATOR = "responsable_logistique@cbi-tunisia.com";
// Vendredis de test (09:00 à Tunis), sans demande réelle (vérifié avant).
const FRIDAY_A = { now: "2026-10-30T08:00:00Z", date: "2026-10-30" };
const FRIDAY_B = { now: "2026-11-06T08:00:00Z", date: "2026-11-06" };
const FRIDAY_C = { now: "2026-11-13T08:00:00Z", date: "2026-11-13" };
const START = new Date();

const users = {};
const createdIds = [];
let legacyBefore;

const token = (u) => `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}`;
const at = (iso) => {
  cfg.clock = () => new Date(iso);
};
const items = [
  { material: "ISO", reference: "ISO-E2E", lot: "L-E2E", quantiteDisponible: 5, besoinProduction: 10, quantiteDemandee: 15 },
  { material: "RESINE", quantiteDisponible: 10, besoinProduction: 25, quantiteDemandee: 15 },
  { material: "ACCELERATEUR", quantiteDisponible: 15, besoinProduction: 45, quantiteDemandee: 25 },
  { material: "GRAIN_PLASTIQUE", quantiteDisponible: 145, besoinProduction: 1000, quantiteDemandee: 855 },
  { material: "FIBRE", quantiteDisponible: 15, besoinProduction: 14, quantiteDemandee: 25 },
];
const uuid = () => require("crypto").randomUUID();

async function createAsProd1(friday) {
  at(friday.now);
  const res = await request(app)
    .post("/raw-material-requests")
    .set("Authorization", token(users.prod1))
    .send({ clientRequestId: uuid(), poste: "matin", items });
  if (res.body?.data?.id) createdIds.push(res.body.data.id);
  return res;
}

beforeAll(async () => {
  for (const [k, email] of [["prod1", PROD1], ["prod2", PROD2], ["validator", VALIDATOR]]) {
    const u = await User.findOne({ where: { email }, attributes: ["id", "email", "role"] });
    if (!u) throw new Error(`Compte introuvable en base : ${email}`);
    users[k] = { id: u.id, email: u.email, role: u.role };
  }
  // Rôle réel vérifié en base (partagé avec production_1..5 — la validation est nominative).
  expect(users.validator.role).toBe("responsable_logistique_achat");
  expect(users.prod1.role).toBe("responsable_logistique_achat");
  expect(users.prod2.role).toBe("responsable_logistique_achat");

  const clash = await RawMaterialRequest.count({ where: { userId: users.prod1.id, requestDate: [FRIDAY_A.date, FRIDAY_B.date, FRIDAY_C.date] } });
  if (clash) throw new Error("Test annulé : une demande réelle existe déjà pour un des vendredis de test.");
  legacyBefore = await RawMaterialRequest.findOne({ where: { requestNumber: "DMP-2026-000001" }, raw: true });
});

afterAll(async () => {
  cfg.clock = () => new Date();
  if (createdIds.length) {
    await History.destroy({ where: { requestId: createdIds } });
    await RawMaterialRequest.destroy({ where: { id: createdIds } });
  }
  await Notification.destroy({ where: { type: "raw_material_request", createdAt: { [Op.gte]: START } } });
  // Numérotation : la prochaine demande réelle reprend juste après la plus grande existante.
  const [row] = await sequelize.query(
    `SELECT COALESCE(MAX(CAST(split_part("requestNumber", '-', 3) AS INTEGER)), 0) AS n FROM raw_material_requests`,
    { type: QueryTypes.SELECT }
  );
  await sequelize.query(`SELECT setval('raw_material_request_number_seq', GREATEST(:n, 1), :called)`, {
    replacements: { n: Number(row.n), called: Number(row.n) > 0 },
  });
  // La demande historique n'a pas bougé.
  const legacyAfter = await RawMaterialRequest.findOne({ where: { requestNumber: "DMP-2026-000001" }, raw: true });
  expect(legacyAfter?.status).toBe(legacyBefore?.status);
  expect(String(legacyAfter?.updatedAt)).toBe(String(legacyBefore?.updatedAt));
  await sequelize.close();
});

describe("production_1 crée, le responsable logistique valide (base réelle)", () => {
  let id;

  test("production_1, vendredi 9 h : popup exigée, puis demande créée « En attente de validation »", async () => {
    at(FRIDAY_A.now);
    const req = await request(app).get("/raw-material-requests/session-requirement").set("Authorization", token(users.prod1));
    expect(req.status).toBe(200);
    expect(req.body.data).toMatchObject({ required: true, poste: "matin", deadlinePassed: false });

    const res = await createAsProd1(FRIDAY_A);
    expect(res.status).toBe(201);
    id = res.body.data.id;
    const row = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(row).toMatchObject({ status: "PENDING_VALIDATION", requestDate: FRIDAY_A.date, userId: users.prod1.id, poste: "matin" });
    expect(row.items).toHaveLength(5);
    expect(enqueueEmailOnce).toHaveBeenCalledWith(expect.objectContaining({ to: VALIDATOR }));
    const notif = await Notification.count({ where: { userId: users.validator.id, type: "raw_material_request", createdAt: { [Op.gte]: START } } });
    expect(notif).toBeGreaterThanOrEqual(1);
  });

  test("production_1 ne peut pas valider sa propre demande (403)", async () => {
    const res = await request(app).patch(`/raw-material-requests/${id}/status`).set("Authorization", token(users.prod1)).send({ status: "VALIDATED" });
    expect(res.status).toBe(403);
    expect((await RawMaterialRequest.findByPk(id, { raw: true })).status).toBe("PENDING_VALIDATION");
  });

  test("responsable : compteur et demandes à valider (toutes demandeuses, sans décision)", async () => {
    const sum = await request(app).get("/raw-material-requests/pending-summary").set("Authorization", token(users.validator));
    expect(sum.status).toBe(200);
    expect(sum.body.data.pending).toBeGreaterThanOrEqual(1);

    const list = await request(app).get("/raw-material-requests").query({ toProcess: true, pageSize: 200 }).set("Authorization", token(users.validator));
    expect(list.status).toBe(200);
    expect(list.body.data.find((r) => r.id === id)).toMatchObject({ status: "PENDING_VALIDATION", userEmail: PROD1 });
    expect(list.body.data.every((r) => ["PENDING_VALIDATION", "SUBMITTED"].includes(r.status))).toBe(true);
  });

  test("responsable : détail complet (références, lots, quantités de chaque matière)", async () => {
    const res = await request(app).get(`/raw-material-requests/${id}`).set("Authorization", token(users.validator));
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i) => [i.material, i.quantiteDisponible, i.besoinProduction, i.quantiteDemandee, i.unite])).toEqual([
      ["ISO", 5, 10, 15, "KG"],
      ["RESINE", 10, 25, 15, "KG"],
      ["ACCELERATEUR", 15, 45, 25, "KG"],
      ["GRAIN_PLASTIQUE", 145, 1000, 855, "KG"],
      ["FIBRE", 15, 14, 25, "KG"],
    ]);
    expect(res.body.data.items[0]).toMatchObject({ reference: "ISO-E2E", lot: "L-E2E" });
    expect(res.body.data.history).toHaveLength(1);
  });

  test("responsable : Valider → statut, auteur, date et historique en base", async () => {
    at("2026-10-30T10:15:00Z");
    const res = await request(app).patch(`/raw-material-requests/${id}/status`).set("Authorization", token(users.validator)).send({ status: "VALIDATED" });
    expect(res.status).toBe(200);
    const row = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(row).toMatchObject({ status: "VALIDATED", validatedBy: users.validator.id, validatedByEmail: VALIDATOR });
    expect(new Date(row.validatedAt).toISOString()).toBe("2026-10-30T10:15:00.000Z");
    const h = await History.findAll({ where: { requestId: id }, order: [["createdAt", "ASC"]], raw: true });
    expect(h.map((x) => [x.fromStatus, x.toStatus, x.changedByEmail])).toEqual([
      [null, "PENDING_VALIDATION", PROD1],
      ["PENDING_VALIDATION", "VALIDATED", VALIDATOR],
    ]);
  });

  test("après reconnexion (nouveaux jetons) : décision conservée, demande retirée des demandes à valider", async () => {
    const list = await request(app).get("/raw-material-requests").query({ toProcess: true, pageSize: 200 }).set("Authorization", token(users.validator));
    expect(list.body.data.some((r) => r.id === id)).toBe(false);
    const detail = await request(app).get(`/raw-material-requests/${id}`).set("Authorization", token(users.prod1));
    expect(detail.body.data).toMatchObject({ status: "VALIDATED", validatedByEmail: VALIDATOR });
    at(FRIDAY_A.now);
    const again = await request(app).get("/raw-material-requests/session-requirement").set("Authorization", token(users.prod1));
    expect(again.body.data).toMatchObject({ required: false, pendingRequestId: id });
  });
});

describe("production_1 crée, le responsable logistique rejette (base réelle)", () => {
  let id;

  test("demande du vendredi suivant, rejet sans motif refusé, rejet motivé enregistré", async () => {
    const created = await createAsProd1(FRIDAY_B);
    expect(created.status).toBe(201);
    id = created.body.data.id;

    let res = await request(app).patch(`/raw-material-requests/${id}/status`).set("Authorization", token(users.validator)).send({ status: "REJECTED" });
    expect(res.status).toBe(400);
    expect((await RawMaterialRequest.findByPk(id, { raw: true })).status).toBe("PENDING_VALIDATION");

    res = await request(app)
      .patch(`/raw-material-requests/${id}/status`)
      .set("Authorization", token(users.validator))
      .send({ status: "REJECTED", comment: "Quantité GRAIN PLASTIQUE à revoir" });
    expect(res.status).toBe(200);
    const row = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(row).toMatchObject({ status: "REJECTED", rejectedBy: users.validator.id, rejectedByEmail: VALIDATOR, rejectionComment: "Quantité GRAIN PLASTIQUE à revoir" });
    expect(row.rejectedAt).toBeTruthy();
  });

  test("après reconnexion : rejet conservé, plus à valider, production_1 invité à corriger", async () => {
    const list = await request(app).get("/raw-material-requests").query({ toProcess: true, pageSize: 200 }).set("Authorization", token(users.validator));
    expect(list.body.data.some((r) => r.id === id)).toBe(false);
    at(FRIDAY_B.now);
    const req = await request(app).get("/raw-material-requests/session-requirement").set("Authorization", token(users.prod1));
    expect(req.body.data.required).toBe(true);
    expect(req.body.data.rejectedRequest).toMatchObject({ id, comment: "Quantité GRAIN PLASTIQUE à revoir" });
  });
});

describe("Shift soir : production_2 prend en charge une demande validée (base réelle)", () => {
  let id;
  const accept = (rid, actualItems) =>
    request(app).post(`/raw-material-requests/${rid}/evening-accept`).set("Authorization", token(users.prod2)).send({ actualItems });

  test("préparation : demande de production_1 validée par le responsable logistique", async () => {
    const created = await createAsProd1(FRIDAY_C);
    expect(created.status).toBe(201);
    id = created.body.data.id;
    at("2026-11-13T10:00:00Z");
    const v = await request(app).patch(`/raw-material-requests/${id}/status`).set("Authorization", token(users.validator)).send({ status: "VALIDATED" });
    expect(v.status).toBe(200);
  });

  test("production_2 voit la demande validée (demandeur, validateur, date de validation, matières)", async () => {
    const list = await request(app).get("/raw-material-requests").query({ status: "VALIDATED", pageSize: 200 }).set("Authorization", token(users.prod2));
    expect(list.status).toBe(200);
    const mine = list.body.data.find((r) => r.id === id);
    expect(mine).toMatchObject({ userEmail: PROD1, validatedByEmail: VALIDATOR, poste: "matin", productionDate: FRIDAY_C.date });
    expect(new Date(mine.validatedAt).toISOString()).toBe("2026-11-13T10:00:00.000Z");
    const detail = await request(app).get(`/raw-material-requests/${id}`).set("Authorization", token(users.prod2));
    expect(detail.body.data).toMatchObject({ canEveningHandle: true, actualItems: null });
    expect(detail.body.data.items.map((i) => i.quantiteDemandee)).toEqual([15, 15, 25, 855, 25]);
  });

  test("production_1 et le responsable ne peuvent pas accepter à la place du shift soir (403)", async () => {
    for (const u of [users.prod1, users.validator]) {
      const res = await request(app).post(`/raw-material-requests/${id}/evening-accept`).set("Authorization", token(u)).send({ actualItems: [{ material: "ISO", quantiteReelle: 1 }] });
      expect(res.status).toBe(403);
    }
  });

  test("quantité réelle négative / manquante refusée, rien n'est écrit", async () => {
    expect((await accept(id, [{ material: "ISO", quantiteReelle: -2 }])).status).toBe(400);
    const missing = await accept(id, [{ material: "ISO", quantiteReelle: 2 }]);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("ACTUAL_QUANTITIES_MISMATCH");
    expect((await RawMaterialRequest.findByPk(id, { raw: true })).status).toBe("VALIDATED");
  });

  test("Accepter : quantités réelles persistées par matière ; validation logistique intacte", async () => {
    at("2026-11-13T15:30:00Z");
    const actual = [
      { material: "ISO", quantiteReelle: 14.5 },
      { material: "RESINE", quantiteReelle: 15 },
      { material: "ACCELERATEUR", quantiteReelle: 0 },
      { material: "GRAIN_PLASTIQUE", quantiteReelle: 840 },
      { material: "FIBRE", quantiteReelle: 25 },
    ];
    const res = await accept(id, actual);
    expect(res.status).toBe(200);
    const row = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(row).toMatchObject({ status: "EVENING_ACCEPTED", eveningHandledBy: users.prod2.id, eveningHandledByEmail: PROD2, validatedByEmail: VALIDATOR });
    expect(new Date(row.validatedAt).toISOString()).toBe("2026-11-13T10:00:00.000Z");
    expect(new Date(row.eveningHandledAt).toISOString()).toBe("2026-11-13T15:30:00.000Z");
    expect(row.actualItems.map((a) => [a.material, a.quantiteReelle])).toEqual(actual.map((a) => [a.material, a.quantiteReelle]));
    expect(row.items.map((i) => i.quantiteDemandee)).toEqual([15, 15, 25, 855, 25]); // lignes validées inchangées
    const h = await History.findAll({ where: { requestId: id }, order: [["createdAt", "ASC"]], raw: true });
    expect(h.map((x) => x.toStatus)).toEqual(["PENDING_VALIDATION", "VALIDATED", "EVENING_ACCEPTED"]);
  });

  test("après reconnexion : quantités réelles conservées ; 2e acceptation / refus impossibles", async () => {
    const detail = await request(app).get(`/raw-material-requests/${id}`).set("Authorization", token(users.prod2));
    expect(detail.body.data).toMatchObject({ status: "EVENING_ACCEPTED", canEveningHandle: false, eveningHandledByEmail: PROD2 });
    expect(detail.body.data.actualItems.find((a) => a.material === "GRAIN_PLASTIQUE").quantiteReelle).toBe(840);
    const again = await accept(id, [{ material: "ISO", quantiteReelle: 1 }, { material: "RESINE", quantiteReelle: 1 }, { material: "ACCELERATEUR", quantiteReelle: 1 }, { material: "GRAIN_PLASTIQUE", quantiteReelle: 1 }, { material: "FIBRE", quantiteReelle: 1 }]);
    expect(again.status).toBe(409);
    const refused = await request(app).post(`/raw-material-requests/${id}/evening-refuse`).set("Authorization", token(users.prod2)).send({ comment: "trop tard" });
    expect(refused.status).toBe(409);
    expect((await RawMaterialRequest.findByPk(id, { raw: true })).actualItems.find((a) => a.material === "ISO").quantiteReelle).toBe(14.5);
  });
});

describe("Shift soir : production_2 refuse une demande validée (base réelle)", () => {
  test("refus motivé enregistré, responsable logistique notifié, demande non retraitable", async () => {
    // Réutilise le vendredi B : sa demande a été rejetée plus haut ; une autre
    // demande validée est créée au nom de production_1 pour un vendredi libre.
    const FRIDAY_D = { now: "2026-11-20T08:00:00Z", date: "2026-11-20" };
    const clash = await RawMaterialRequest.count({ where: { userId: users.prod1.id, requestDate: FRIDAY_D.date } });
    expect(clash).toBe(0);
    const created = await createAsProd1(FRIDAY_D);
    const id = created.body.data.id;
    at("2026-11-20T10:00:00Z");
    expect((await request(app).patch(`/raw-material-requests/${id}/status`).set("Authorization", token(users.validator)).send({ status: "VALIDATED" })).status).toBe(200);

    const before = await Notification.count({ where: { userId: users.validator.id, type: "raw_material_request" } });
    let res = await request(app).post(`/raw-material-requests/${id}/evening-refuse`).set("Authorization", token(users.prod2)).send({ comment: " " });
    expect(res.status).toBe(400);
    at("2026-11-20T16:00:00Z");
    res = await request(app).post(`/raw-material-requests/${id}/evening-refuse`).set("Authorization", token(users.prod2)).send({ comment: "Stock ISO insuffisant ce soir" });
    expect(res.status).toBe(200);

    const row = await RawMaterialRequest.findByPk(id, { raw: true });
    expect(row).toMatchObject({ status: "EVENING_REFUSED", eveningRefusalComment: "Stock ISO insuffisant ce soir", eveningHandledBy: users.prod2.id, validatedByEmail: VALIDATOR });
    const after = await Notification.findAll({ where: { userId: users.validator.id, type: "raw_material_request" }, order: [["createdAt", "DESC"]], raw: true });
    expect(after.length).toBe(before + 1);
    expect(after[0].title).toBe("Demande de matières premières refusée par le shift soir");
    expect(enqueueEmailOnce).toHaveBeenCalledWith(expect.objectContaining({ to: VALIDATOR, subject: expect.stringContaining("refusée par le shift soir") }));

    // Reconnexion : refus conservé, impossible d'accepter ensuite.
    const detail = await request(app).get(`/raw-material-requests/${id}`).set("Authorization", token(users.prod2));
    expect(detail.body.data).toMatchObject({ status: "EVENING_REFUSED", eveningRefusalComment: "Stock ISO insuffisant ce soir", canEveningHandle: false });
    const accepted = await request(app)
      .post(`/raw-material-requests/${id}/evening-accept`)
      .set("Authorization", token(users.prod2))
      .send({ actualItems: [{ material: "ISO", quantiteReelle: 1 }] });
    expect(accepted.status).toBe(409);
  });
});
