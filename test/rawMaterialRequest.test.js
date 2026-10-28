"use strict";

// Demande de matières premières du VENDREDI (production_1, poste Matin),
// validée par le responsable logistique achats avant 14 h, et traçabilité.
// Aucune base réelle : modèles, connexion et notifications sont simulés ;
// l'horloge du serveur est fixée par test (cfg.clock). Les routes sont
// montées sur une app Express minimale avec de vrais JWT.

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "raw-material-request-test-secret";

jest.mock("../src/db", () => ({ sequelize: { query: jest.fn(), transaction: jest.fn(async (fn) => fn({ id: "tx" })) } }));
jest.mock("../src/models/RawMaterialRequest", () => ({
  findOne: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  count: jest.fn(),
  findAndCountAll: jest.fn(),
}));
jest.mock("../src/models/RawMaterialRequestStatusHistory", () => ({ create: jest.fn(), findAll: jest.fn() }));
jest.mock("../src/modules/raw-material-requests/services/rawMaterialRequestNotify.service", () => ({
  notifySubmitted: jest.fn(),
  notifyDecision: jest.fn(),
  notifyLate: jest.fn(),
  notifyEveningRefused: jest.fn(),
  broadcastUpdated: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const ExcelJS = require("exceljs");
const { Op, UniqueConstraintError } = require("sequelize");

const { sequelize } = require("../src/db");
const RawMaterialRequest = require("../src/models/RawMaterialRequest");
const History = require("../src/models/RawMaterialRequestStatusHistory");
const notify = require("../src/modules/raw-material-requests/services/rawMaterialRequestNotify.service");
const cfg = require("../src/config/rawMaterialRequest");
const svc = require("../src/modules/raw-material-requests/services/rawMaterialRequest.service");
const { signAccessToken } = require("../src/utils/tokens");
const { authRequired } = require("../src/middleware/auth.middleware");
const { rawMaterialRequestGuard } = require("../src/modules/raw-material-requests/middleware/rawMaterialRequestGuard");
const routes = require("../src/modules/raw-material-requests/routes/rawMaterialRequest.routes");

// Comptes réels (identifiants vérifiés en base locale).
const PROD1 = { sub: "dd746847-c5ad-42e9-a5ab-4a721a0e3839", email: "production_1@cbi-tunisia.com", role: "responsable_logistique_achat" };
const PROD2 = { sub: "b2f9e7bf-20b9-4501-8e35-76a921c288f4", email: "production_2@cbi-tunisia.com", role: "responsable_logistique_achat" };
const PROD3 = { sub: "23c1b6ff-795c-49ea-8633-14323881034a", email: "production_3@cbi-tunisia.com", role: "responsable_logistique_achat" };
const VALIDATOR = { sub: "b4a9bf6f-65f1-4dd7-9a38-bb7a07210641", email: "responsable_logistique@cbi-tunisia.com", role: "responsable_logistique_achat" };
const ADMIN = { sub: "44444444-4444-4444-8444-444444444444", email: "admin@cbi-tunisia.com", role: "superadmin" };
const REQ_ID = "66666666-6666-4666-8666-666666666666";

// Heures de Tunis (UTC+1) : jeudi 29/10/2026 10:00, vendredi 30/10/2026 09:00, 13:30, 15:00.
const THURSDAY = new Date("2026-10-29T09:00:00Z");
const FRIDAY_9H = new Date("2026-10-30T08:00:00Z");
const FRIDAY_13H30 = new Date("2026-10-30T12:30:00Z");
const FRIDAY_15H = new Date("2026-10-30T14:00:00Z");
const DEADLINE = new Date("2026-10-30T13:00:00Z"); // vendredi 14:00 à Tunis
const at = (d) => {
  cfg.clock = () => new Date(d);
};

const bearer = (u) => `Bearer ${signAccessToken(u)}`;

const ITEMS = [
  { material: "RESINE", reference: "REF-R", lot: "L1", quantiteDisponible: 120, besoinProduction: 200, quantiteDemandee: 80 },
  { material: "ISO", reference: "", lot: null, quantiteDisponible: 0, besoinProduction: 50.5, quantiteDemandee: 50.5 },
];
const body = (over = {}) => ({ clientRequestId: "9b2f1c1e-6a39-4c3e-9a51-0e7f5b2a1d01", module: "promesh", machine: "1", poste: "matin", items: ITEMS, ...over });

const stored = (over = {}) => ({
  id: REQ_ID,
  requestNumber: "DMP-2026-000002",
  userId: PROD1.sub,
  userEmail: PROD1.email,
  module: null,
  poste: "matin",
  requestDate: "2026-10-30",
  productionDate: "2026-10-30",
  status: "PENDING_VALIDATION",
  deadlineAt: DEADLINE.toISOString(),
  items: [
    { material: "ISO", label: "ISO", reference: "ISO-1", lot: "L1", quantiteDisponible: 10, besoinProduction: 30, quantiteDemandee: 20, unite: "KG" },
    { material: "FIBRE", label: "FIBRE", reference: null, lot: null, quantiteDisponible: 0, besoinProduction: 5.5, quantiteDemandee: 5.5, unite: "KG" },
  ],
  createdAt: "2026-10-30T07:15:00.000Z",
  ...over,
});

// Routes de demandes + deux routes de création factices protégées par le
// garde, comme POST /por-promesh/new et POST /industrial-records.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/raw-material-requests", routes);
  app.post("/por-promesh/new", authRequired, rawMaterialRequestGuard({ source: "promesh" }), (req, res) =>
    res.status(201).json({ success: true, data: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } })
  );
  app.post("/industrial-records", authRequired, rawMaterialRequestGuard({ source: "probar" }), (req, res) =>
    res.status(201).json({ success: true, data: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } })
  );
  return app;
}
const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
  at(FRIDAY_9H);
  RawMaterialRequest.findOne.mockResolvedValue(null);
  RawMaterialRequest.update.mockResolvedValue([1]);
  RawMaterialRequest.create.mockImplementation(async (v) => ({ id: "req-new", ...v, toJSON: () => ({ id: "req-new", ...v }) }));
  sequelize.query.mockResolvedValue([[{ n: "7" }]]); // séquence des numéros de demande
  History.create.mockResolvedValue({});
  History.findAll.mockResolvedValue([]);
});

afterAll(() => {
  cfg.clock = () => new Date();
});

// ── 1. Calendrier ──────────────────────────────────────────────────────────
describe("Popup à la connexion : uniquement le vendredi (heure du serveur)", () => {
  const session = (u = PROD1) => request(app).get("/raw-material-requests/session-requirement").set("Authorization", bearer(u));

  test("jeudi : pas de popup, aucune lecture en base", async () => {
    at(THURSDAY);
    const res = await session();
    expect(res.body.data).toMatchObject({ required: false, isRequestDay: false, deadlineAt: null });
    expect(RawMaterialRequest.findOne).not.toHaveBeenCalled();
  });

  test("vendredi avant 14 h, aucune demande : popup, échéance vendredi 14 h, poste Matin", async () => {
    const res = await session();
    expect(res.body.data).toMatchObject({
      required: true,
      poste: "matin",
      requestDate: "2026-10-30",
      isRequestDay: true,
      deadlineAt: DEADLINE.toISOString(),
      deadlinePassed: false,
      rejectedRequest: null,
    });
    expect(RawMaterialRequest.findOne.mock.calls[0][0].where).toEqual({ userId: PROD1.sub, poste: "matin", requestDate: "2026-10-30" });
  });

  test("vendredi après 14 h, aucune demande : popup avec échéance dépassée", async () => {
    at(FRIDAY_15H);
    const res = await session();
    expect(res.body.data).toMatchObject({ required: true, deadlinePassed: true });
  });

  test("reconnexion le même vendredi après soumission : pas de nouvelle popup", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored());
    const res = await session();
    expect(res.body.data).toMatchObject({ required: false, pendingRequestId: REQ_ID });
  });

  test.each(["VALIDATED", "IN_PROGRESS", "PROCESSED"])("demande du vendredi déjà %s : pas de popup", async (status) => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ status }));
    expect((await session()).body.data.required).toBe(false);
  });

  test("demande rejetée ce vendredi : popup pour la corriger (valeurs et motif renvoyés)", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ status: "REJECTED", rejectionComment: "Quantités ISO trop élevées" }));
    const res = await session();
    expect(res.body.data.required).toBe(true);
    expect(res.body.data.rejectedRequest).toMatchObject({ id: REQ_ID, comment: "Quantités ISO trop élevées" });
    expect(res.body.data.rejectedRequest.items).toHaveLength(2);
  });

  test.each([
    ["production_2 (poste Soir)", PROD2],
    ["responsable logistique", VALIDATOR],
    ["superadmin", ADMIN],
  ])("%s le vendredi : jamais de popup", async (_l, user) => {
    expect((await session(user)).body.data.required).toBe(false);
  });

  test("calendrier : vendredi 23:30 à Tunis est encore vendredi, samedi 00:30 non", () => {
    expect(cfg.dayContext(new Date("2026-10-30T22:30:00Z"))).toMatchObject({ date: "2026-10-30", isRequestDay: true, deadlinePassed: true });
    expect(cfg.dayContext(new Date("2026-10-30T23:30:00Z"))).toMatchObject({ date: "2026-10-31", isRequestDay: false });
  });
});

// ── 2. Soumission ──────────────────────────────────────────────────────────
describe("Soumission de la demande du vendredi", () => {
  const post = (b = body(), u = PROD1) => request(app).post("/raw-material-requests").set("Authorization", bearer(u)).send(b);

  test("vendredi avant 14 h : « En attente de validation », date du vendredi, échéance 14 h, responsable notifié", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const saved = RawMaterialRequest.create.mock.calls[0][0];
    expect(saved).toMatchObject({
      userId: PROD1.sub,
      userEmail: PROD1.email,
      poste: "matin",
      requestDate: "2026-10-30",
      productionDate: "2026-10-30",
      status: "PENDING_VALIDATION",
      deadlineAt: DEADLINE,
    });
    expect(saved.requestNumber).toBe("DMP-2026-000007");
    // Ordre du modèle : ISO puis RESINE ; libellés et unité fixés par le serveur.
    expect(saved.items.map((i) => [i.material, i.label, i.unite])).toEqual([["ISO", "ISO", "KG"], ["RESINE", "RESINE", "KG"]]);
    expect(History.create).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: null, toStatus: "PENDING_VALIDATION", changedBy: PROD1.sub }),
      { transaction: { id: "tx" } }
    );
    expect(notify.notifySubmitted).toHaveBeenCalledTimes(1);
    expect(notify.notifyLate).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ status: "PENDING_VALIDATION", overdue: false });
  });

  test("vendredi après 14 h : enregistrée en attente, signalée en retard immédiatement (jamais validée)", async () => {
    at(FRIDAY_15H);
    const res = await post();
    expect(res.status).toBe(201);
    expect(RawMaterialRequest.create.mock.calls[0][0].status).toBe("PENDING_VALIDATION");
    expect(RawMaterialRequest.update).toHaveBeenCalledWith({ lateNotifiedAt: new Date(FRIDAY_15H) }, { where: { id: "req-new", lateNotifiedAt: null } });
    expect(notify.notifyLate).toHaveBeenCalledTimes(1);
    expect(res.body.data).toMatchObject({ status: "PENDING_VALIDATION", overdue: true });
  });

  test("jeudi : soumission refusée (403)", async () => {
    at(THURSDAY);
    const res = await post();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RAW_MATERIAL_REQUEST_NOT_APPLICABLE");
    expect(RawMaterialRequest.create).not.toHaveBeenCalled();
  });

  test("absence de doublon : une demande existe déjà pour ce vendredi → 409", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(stored());
    const res = await post(body({ clientRequestId: "11111111-2222-4333-8444-555555555555" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_REQUEST");
    expect(RawMaterialRequest.create).not.toHaveBeenCalled();
  });

  test("demande rejetée : nouvelle création refusée, il faut la corriger (409)", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(stored({ status: "REJECTED" }));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REQUEST_REJECTED_RESUBMIT");
  });

  test("double clic (même clientRequestId) : la demande déjà enregistrée est renvoyée, rien n'est recréé", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(stored());
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.alreadyExisting).toBe(true);
    expect(RawMaterialRequest.create).not.toHaveBeenCalled();
    expect(notify.notifySubmitted).not.toHaveBeenCalled();
  });

  test("deux soumissions simultanées : l'index unique (utilisateur, poste, jour) en refuse une (409)", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(stored());
    RawMaterialRequest.create.mockRejectedValue(new UniqueConstraintError({}));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_REQUEST");
  });

  test.each([
    ["quantité négative", [{ ...ITEMS[0], quantiteDemandee: -1 }], /négatif/],
    ["quantité non numérique", [{ ...ITEMS[0], besoinProduction: "abc" }], /nombre valide/],
    ["matière retirée (PG)", [{ ...ITEMS[0], material: "PG" }], /Matière inconnue/],
    ["matière en double", [ITEMS[0], ITEMS[0]], /une seule fois/],
    ["aucune matière", [], /au moins une matière/],
  ])("refusée : %s (400)", async (_l, items, msg) => {
    const res = await post(body({ items }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(msg);
  });

  test("les 5 matières (ISO → FIBRE) sont acceptées", async () => {
    const codes = ["ISO", "RESINE", "ACCELERATEUR", "GRAIN_PLASTIQUE", "FIBRE"];
    const items = [...codes].reverse().map((material, i) => ({ material, quantiteDisponible: i, besoinProduction: i * 10, quantiteDemandee: i * 5 }));
    const res = await post(body({ items }));
    expect(res.status).toBe(201);
    expect(RawMaterialRequest.create.mock.calls[0][0].items.map((i) => i.label)).toEqual(["ISO", "RESINE", "ACCELERATEUR", "GRAIN PLASTIQUE", "FIBRE"]);
  });
});

// ── 3. Validation / rejet par le responsable logistique achats ────────────
describe("Validation et rejet", () => {
  const patch = (u, payload) => request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(u)).send(payload);

  test("permissions : seul le responsable logistique peut valider ; production_1 jamais", async () => {
    const perms = async (u) => (await request(app).get("/raw-material-requests/permissions").set("Authorization", bearer(u))).body.data;
    const v = await perms(VALIDATOR);
    expect(v).toMatchObject({ canView: true, fullVisibility: true, canValidate: true });
    expect(v.transitions.PENDING_VALIDATION).toEqual(["VALIDATED", "REJECTED"]);
    const p1 = await perms(PROD1);
    expect(p1).toMatchObject({ canView: true, fullVisibility: false, canValidate: false, canManageStatus: false });
    expect(p1.transitions.PENDING_VALIDATION).toEqual([]);
    const admin = await perms(ADMIN);
    expect(admin).toMatchObject({ fullVisibility: true, canValidate: false });
    expect(admin.transitions.PENDING_VALIDATION).toEqual([]);
    expect((await perms(PROD3)).canView).toBe(false);
  });

  test("Valider : auteur, date et heure enregistrés, historique, demandeur notifié", async () => {
    at(FRIDAY_13H30);
    RawMaterialRequest.findOne.mockResolvedValueOnce(stored()).mockResolvedValueOnce(stored({ status: "VALIDATED", validatedByEmail: VALIDATOR.email }));
    const res = await patch(VALIDATOR, { status: "VALIDATED" });
    expect(res.status).toBe(200);
    const [changes, opts] = RawMaterialRequest.update.mock.calls[0];
    expect(changes).toEqual({ status: "VALIDATED", validatedAt: new Date(FRIDAY_13H30), validatedBy: VALIDATOR.sub, validatedByEmail: VALIDATOR.email });
    expect(opts.where).toEqual({ id: REQ_ID, status: "PENDING_VALIDATION" });
    expect(History.create.mock.calls[0][0]).toEqual({
      requestId: REQ_ID, fromStatus: "PENDING_VALIDATION", toStatus: "VALIDATED", changedBy: VALIDATOR.sub, changedByEmail: VALIDATOR.email, comment: null,
    });
    expect(notify.notifyDecision).toHaveBeenCalledWith(expect.anything(), { status: "VALIDATED", comment: null, byEmail: VALIDATOR.email });
  });

  test("Rejeter avec commentaire : auteur, date, motif enregistrés", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(stored()).mockResolvedValueOnce(stored({ status: "REJECTED" }));
    const res = await patch(VALIDATOR, { status: "REJECTED", comment: "  Quantité FIBRE à revoir  " });
    expect(res.status).toBe(200);
    expect(RawMaterialRequest.update.mock.calls[0][0]).toEqual({
      status: "REJECTED", rejectedAt: new Date(FRIDAY_9H), rejectedBy: VALIDATOR.sub, rejectedByEmail: VALIDATOR.email, rejectionComment: "Quantité FIBRE à revoir",
    });
    expect(History.create.mock.calls[0][0]).toMatchObject({ fromStatus: "PENDING_VALIDATION", toStatus: "REJECTED", comment: "Quantité FIBRE à revoir" });
    expect(notify.notifyDecision.mock.calls[0][1]).toMatchObject({ status: "REJECTED", comment: "Quantité FIBRE à revoir" });
  });

  test("validation après l'échéance : possible (manuelle), date réelle enregistrée", async () => {
    at(FRIDAY_15H);
    RawMaterialRequest.findOne.mockResolvedValueOnce(stored()).mockResolvedValueOnce(stored({ status: "VALIDATED" }));
    const res = await patch(VALIDATOR, { status: "VALIDATED" });
    expect(res.status).toBe(200);
    expect(RawMaterialRequest.update.mock.calls[0][0].validatedAt).toEqual(new Date(FRIDAY_15H));
  });

  test("production_1 ne peut jamais valider sa propre demande (403)", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored());
    const res = await patch(PROD1, { status: "VALIDATED" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWN_REQUEST");
    expect(RawMaterialRequest.update).not.toHaveBeenCalled();
  });

  test("le validateur ne statue pas sur sa propre demande (403)", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ userId: VALIDATOR.sub }));
    expect((await patch(VALIDATOR, { status: "VALIDATED" })).status).toBe(403);
  });

  test("un superadmin ne valide pas une demande en attente (403 NOT_VALIDATOR)", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored());
    const res = await patch(ADMIN, { status: "VALIDATED" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_VALIDATOR");
  });

  test("production_2 : une demande en attente ne lui est pas visible (404)", async () => {
    const res = await patch(PROD2, { status: "VALIDATED" });
    expect(res.status).toBe(404);
    const where = RawMaterialRequest.findOne.mock.calls[0][0].where;
    expect(where.id).toBe(REQ_ID);
    // Shift soir : ses demandes + les demandes validées / traitées, jamais celles en attente.
    expect(where[Op.or]).toEqual([{ userId: PROD2.sub }, { status: { [Op.in]: ["VALIDATED", "EVENING_ACCEPTED", "EVENING_REFUSED", "PROCESSED"] } }]);
  });

  test.each([
    ["En attente → Traitée", "PENDING_VALIDATION", "PROCESSED"],
    ["Rejetée → Validée", "REJECTED", "VALIDATED"],
    ["Traitée → En attente", "PROCESSED", "PENDING_VALIDATION"],
  ])("transition interdite (409) : %s", async (_l, from, to) => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ status: from }));
    const res = await patch(VALIDATOR, { status: to });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS_TRANSITION");
  });

  test("décision simultanée : 409, rien d'écrit dans l'historique", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored());
    RawMaterialRequest.update.mockResolvedValue([0]);
    const res = await patch(VALIDATOR, { status: "REJECTED", comment: "Doublon" });
    expect(res.status).toBe(409);
    expect(History.create).not.toHaveBeenCalled();
  });

  test.each([
    ["sans commentaire", {}],
    ["commentaire vide", { comment: "   " }],
  ])("rejet %s : refusé (400), rien n'est écrit, la demande reste en attente", async (_l, extra) => {
    RawMaterialRequest.findOne.mockResolvedValue(stored());
    const res = await patch(VALIDATOR, { status: "REJECTED", ...extra });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REJECTION_COMMENT_REQUIRED");
    expect(RawMaterialRequest.update).not.toHaveBeenCalled();
    expect(History.create).not.toHaveBeenCalled();
    expect(notify.notifyDecision).not.toHaveBeenCalled();
  });

  test("la liste des demandes à traiter vient du backend : statut « En attente de validation », toutes demandeuses", async () => {
    RawMaterialRequest.findAndCountAll.mockResolvedValue({ rows: [stored(), stored({ id: "b", requestNumber: "DMP-2026-000003" })], count: 2 });
    const res = await request(app).get("/raw-material-requests").query({ status: "PENDING_VALIDATION", pageSize: 100 }).set("Authorization", bearer(VALIDATOR));
    expect(res.body.count).toBe(2);
    expect(RawMaterialRequest.findAndCountAll.mock.calls[0][0].where).toEqual({ status: "PENDING_VALIDATION" });
    expect(res.body.data[0].items).toHaveLength(2);
  });

  test("après validation : traitement par un gestionnaire (Validée → En cours de traitement)", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(stored({ status: "VALIDATED" })).mockResolvedValueOnce(stored({ status: "IN_PROGRESS" }));
    const res = await patch(ADMIN, { status: "IN_PROGRESS" });
    expect(res.status).toBe(200);
    expect(notify.notifyDecision).not.toHaveBeenCalled();
  });
});

// ── 4. Correction d'une demande rejetée ───────────────────────────────────
describe("Correction et nouvelle soumission après rejet", () => {
  const put = (u = PROD1, items = ITEMS) => request(app).put(`/raw-material-requests/${REQ_ID}/resubmit`).set("Authorization", bearer(u)).send({ items });

  test("même demande remise en attente, nouvelles valeurs, historique conservé, responsable notifié", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(stored({ status: "REJECTED" })).mockResolvedValueOnce(stored());
    History.findAll.mockResolvedValue([
      { fromStatus: null, toStatus: "PENDING_VALIDATION" },
      { fromStatus: "PENDING_VALIDATION", toStatus: "REJECTED", comment: "Quantité FIBRE à revoir" },
      { fromStatus: "REJECTED", toStatus: "PENDING_VALIDATION", comment: "Demande corrigée et soumise à nouveau" },
    ]);
    const res = await put();
    expect(res.status).toBe(200);
    const [changes, opts] = RawMaterialRequest.update.mock.calls[0];
    expect(changes).toMatchObject({ status: "PENDING_VALIDATION", rejectedAt: null, rejectionComment: null, lateNotifiedAt: null });
    expect(changes.items.map((i) => i.material)).toEqual(["ISO", "RESINE"]);
    expect(opts.where).toEqual({ id: REQ_ID, status: "REJECTED" });
    expect(History.create.mock.calls[0][0]).toMatchObject({ fromStatus: "REJECTED", toStatus: "PENDING_VALIDATION", changedBy: PROD1.sub });
    expect(RawMaterialRequest.create).not.toHaveBeenCalled();
    expect(notify.notifySubmitted).toHaveBeenCalledWith(expect.anything(), { resubmitted: true });
    expect(res.body.data.history).toHaveLength(3);
  });

  test("seul le demandeur corrige sa demande (introuvable pour un autre)", async () => {
    const res = await put(PROD2);
    expect(res.status).toBe(404);
    expect(RawMaterialRequest.findOne.mock.calls[0][0].where).toEqual({ id: REQ_ID, userId: PROD2.sub });
  });

  test("une demande non rejetée ne se « resoumet » pas (409)", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored());
    const res = await put();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_REJECTED");
  });

  test("matières invalides refusées (400)", async () => {
    expect((await put(PROD1, [{ ...ITEMS[0], material: "COURANT" }])).status).toBe(400);
  });
});

// ── 5. Échéance et retard ─────────────────────────────────────────────────
describe("Échéance du vendredi 14 h", () => {
  test("indicateurs : échéance proche à 13 h 30, en retard à 15 h, rien une fois validée", async () => {
    RawMaterialRequest.findAndCountAll.mockResolvedValue({ rows: [stored(), stored({ id: "x", status: "VALIDATED" })], count: 2 });
    at(FRIDAY_13H30);
    let res = await request(app).get("/raw-material-requests").set("Authorization", bearer(VALIDATOR));
    expect(res.body.data[0]).toMatchObject({ dueSoon: true, overdue: false, deadlineAt: DEADLINE.toISOString() });
    at(FRIDAY_15H);
    res = await request(app).get("/raw-material-requests").set("Authorization", bearer(VALIDATOR));
    expect(res.body.data[0]).toMatchObject({ dueSoon: false, overdue: true, status: "PENDING_VALIDATION" });
    expect(res.body.data[1]).toMatchObject({ dueSoon: false, overdue: false });
  });

  test("bandeau du responsable : en attente, en retard, échéance proche", async () => {
    at(FRIDAY_13H30);
    RawMaterialRequest.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const res = await request(app).get("/raw-material-requests/pending-summary").set("Authorization", bearer(VALIDATOR));
    expect(res.body.data).toEqual({ pending: 3, overdue: 1, dueSoon: 2 });
    expect(RawMaterialRequest.count.mock.calls[1][0].where).toEqual({ status: "PENDING_VALIDATION", deadlineAt: { [Op.lte]: new Date(FRIDAY_13H30) } });
  });

  test("alerte de retard : une seule fois par demande, statut inchangé (pas de validation automatique)", async () => {
    at(FRIDAY_15H);
    RawMaterialRequest.findAll.mockResolvedValue([stored(), stored({ id: "other" })]);
    RawMaterialRequest.update.mockResolvedValueOnce([1]).mockResolvedValueOnce([0]); // la 2e déjà signalée par un autre passage
    const out = await svc.sweepLate();
    expect(out).toEqual({ checked: 2, notified: 1 });
    expect(RawMaterialRequest.findAll.mock.calls[0][0].where).toEqual({
      status: "PENDING_VALIDATION", deadlineAt: { [Op.lte]: new Date(FRIDAY_15H) }, lateNotifiedAt: null,
    });
    for (const [changes] of RawMaterialRequest.update.mock.calls) expect(changes).toEqual({ lateNotifiedAt: new Date(FRIDAY_15H) });
    expect(notify.notifyLate).toHaveBeenCalledTimes(1);
  });
});

// ── 6. Création des fiches de production ──────────────────────────────────
describe("Création de fiche : contrôle du vendredi uniquement", () => {
  const promesh = (u = PROD1, poste = "matin") => request(app).post("/por-promesh/new").set("Authorization", bearer(u)).send({ machine: "1", poste });

  test("jeudi : création libre, aucune vérification", async () => {
    at(THURSDAY);
    expect((await promesh()).status).toBe(201);
    expect(RawMaterialRequest.findOne).not.toHaveBeenCalled();
  });

  test("vendredi sans demande : création bloquée (403)", async () => {
    const res = await promesh();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RAW_MATERIAL_REQUEST_REQUIRED");
  });

  test("vendredi, demande en attente : création autorisée, 1re fiche rattachée à la demande", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored());
    expect((await promesh()).status).toBe(201);
    expect(RawMaterialRequest.update).toHaveBeenCalledWith(
      { ficheType: "PROMESH", ficheId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", consumedAt: new Date(FRIDAY_9H) },
      { where: { id: REQ_ID, ficheId: null } }
    );
  });

  test("vendredi, 2e fiche : la même demande suffit (plus de consommation par fiche)", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ ficheId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    expect((await promesh()).status).toBe(201);
    expect(RawMaterialRequest.update).not.toHaveBeenCalled();
  });

  test("vendredi, demande rejetée : création bloquée jusqu'à correction", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ status: "REJECTED" }));
    expect((await promesh()).status).toBe(403);
  });

  test("MÉLANGE (sans poste) : même contrôle le vendredi ; MAINTENANCE jamais", async () => {
    let res = await request(app).post("/industrial-records").set("Authorization", bearer(PROD1)).send({ module: "melange" });
    expect(res.status).toBe(403);
    res = await request(app).post("/industrial-records").set("Authorization", bearer(PROD1)).send({ module: "maintenance" });
    expect(res.status).toBe(201);
  });

  test.each([
    ["production_1 au poste Soir", PROD1, "nuit"],
    ["production_2", PROD2, "matin"],
    ["responsable logistique", VALIDATOR, "matin"],
  ])("vendredi, %s : création inchangée", async (_l, u, poste) => {
    expect((await promesh(u, poste)).status).toBe(201);
    expect(RawMaterialRequest.findOne).not.toHaveBeenCalled();
  });

  test("erreur base pendant la vérification → échec fermé (503)", async () => {
    RawMaterialRequest.findOne.mockRejectedValue(new Error("db down"));
    expect((await promesh()).status).toBe(503);
  });
});

// ── 7. Traçabilité ────────────────────────────────────────────────────────
describe("Traçabilité : liste, filtres, détail, export", () => {
  test("demandeur : uniquement ses demandes ; filtre utilisateur ignoré", async () => {
    RawMaterialRequest.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    await request(app).get("/raw-material-requests").query({ userId: PROD2.sub }).set("Authorization", bearer(PROD1));
    expect(RawMaterialRequest.findAndCountAll.mock.calls[0][0].where).toEqual({ userId: PROD1.sub });
  });

  test("responsable : tous les filtres appliqués, dont le nouveau statut", async () => {
    RawMaterialRequest.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    const res = await request(app)
      .get("/raw-material-requests")
      .query({ from: "2026-10-01", to: "2026-10-31", poste: "matin", material: "ISO", status: "PENDING_VALIDATION", search: "0002" })
      .set("Authorization", bearer(VALIDATOR));
    expect(res.status).toBe(200);
    const where = RawMaterialRequest.findAndCountAll.mock.calls[0][0].where;
    expect(where).toMatchObject({ poste: "matin", status: "PENDING_VALIDATION" });
    expect(where.items).toEqual({ [Op.contains]: [{ material: "ISO" }] });
    expect(where.requestNumber).toEqual({ [Op.iLike]: "%0002%" });
  });

  test("détail : matières, références, lots, quantités ; correction proposée au demandeur si rejetée", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ status: "REJECTED", rejectionComment: "À revoir", rejectedByEmail: VALIDATOR.email }));
    History.findAll.mockResolvedValue([{ id: "h1", fromStatus: null, toStatus: "PENDING_VALIDATION" }]);
    const res = await request(app).get(`/raw-material-requests/${REQ_ID}`).set("Authorization", bearer(PROD1));
    expect(res.body.data).toMatchObject({ status: "REJECTED", rejectionComment: "À revoir", rejectedByEmail: VALIDATOR.email, canResubmit: true });
    expect(res.body.data.items[0]).toMatchObject({ material: "ISO", reference: "ISO-1", lot: "L1", quantiteDemandee: 20 });
  });

  test("export Excel : une ligne par matière, statut « En attente de validation »", async () => {
    RawMaterialRequest.findAll.mockResolvedValue([stored()]);
    const res = await request(app)
      .get("/raw-material-requests/export")
      .set("Authorization", bearer(VALIDATOR))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.worksheets[0];
    expect(ws.rowCount).toBe(3);
    expect(ws.getRow(2).values.slice(1)).toEqual([
      "DMP-2026-000002", "30/10/2026 08:15", PROD1.email, "Matin", "30/10/2026", "ISO", "ISO-1", "L1", 10, 30, 20, undefined, "KG", "En attente de validation",
    ]);
    expect(ws.getRow(3).getCell(6).value).toBe("FIBRE");
  });
});

describe("Export Excel — demande à 5 matières (valeurs individuelles, aucun total)", () => {
  // Valeurs de la demande réelle DMP-2026-000001 (base locale, 26/10/2026).
  const five = stored({
    status: "SUBMITTED",
    deadlineAt: null,
    items: [
      { material: "ISO", label: "ISO", reference: null, lot: null, quantiteDisponible: 5, besoinProduction: 10, quantiteDemandee: 15, unite: "KG" },
      { material: "RESINE", label: "RESINE", reference: null, lot: null, quantiteDisponible: 10, besoinProduction: 25, quantiteDemandee: 15, unite: "KG" },
      { material: "ACCELERATEUR", label: "ACCELERATEUR", reference: null, lot: null, quantiteDisponible: 15, besoinProduction: 45, quantiteDemandee: 25, unite: "KG" },
      { material: "GRAIN_PLASTIQUE", label: "GRAIN PLASTIQUE", reference: null, lot: null, quantiteDisponible: 145, besoinProduction: 1000, quantiteDemandee: 855, unite: "KG" },
      { material: "FIBRE", label: "FIBRE", reference: null, lot: null, quantiteDisponible: 15, besoinProduction: 14, quantiteDemandee: 25, unite: "KG" },
    ],
  });

  async function exportSheet(query) {
    RawMaterialRequest.findAll.mockResolvedValue([five]);
    const res = await request(app)
      .get("/raw-material-requests/export")
      .query(query)
      .set("Authorization", bearer(VALIDATOR))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    return wb.worksheets[0];
  }

  test("5 lignes, chacune avec ses propres quantités et son unité ; cellules vides si rien n'est saisi", async () => {
    const ws = await exportSheet({});
    expect(ws.rowCount).toBe(6);
    const lines = [2, 3, 4, 5, 6].map((n) => ws.getRow(n).values.slice(1));
    expect(lines.map((l) => l[0])).toEqual(Array(5).fill("DMP-2026-000002"));
    expect(lines.map((l) => [l[5], l[8], l[9], l[10], l[12], l[13]])).toEqual([
      ["ISO", 5, 10, 15, "KG", "Soumise"],
      ["RESINE", 10, 25, 15, "KG", "Soumise"],
      ["ACCELERATEUR", 15, 45, 25, "KG", "Soumise"],
      ["GRAIN PLASTIQUE", 145, 1000, 855, "KG", "Soumise"],
      ["FIBRE", 15, 14, 25, "KG", "Soumise"],
    ]);
    // Référence, lot, quantité réelle (pas encore saisie) et validation : cellules vides.
    expect(lines.every((l) => l[6] === undefined && l[7] === undefined && l[11] === undefined && l[14] === undefined)).toBe(true);
  });

  test("filtre matière : uniquement les lignes de cette matière", async () => {
    const ws = await exportSheet({ material: "GRAIN_PLASTIQUE" });
    expect(ws.rowCount).toBe(2);
    expect(ws.getRow(2).values.slice(1)).toEqual(expect.arrayContaining(["DMP-2026-000002", "GRAIN PLASTIQUE", 145, 1000, 855, "KG"]));
  });
});

// ── Correction : demandes « Soumise » (antérieures à la validation) à traiter ─
describe("Demandes à valider : en attente ET soumises, quel que soit le demandeur", () => {
  test("compteur : demandes sans décision (PENDING_VALIDATION + SUBMITTED)", async () => {
    RawMaterialRequest.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const res = await request(app).get("/raw-material-requests/pending-summary").set("Authorization", bearer(VALIDATOR));
    expect(res.body.data.pending).toBe(1);
    expect(RawMaterialRequest.count.mock.calls[0][0].where).toEqual({ status: { [Op.in]: ["PENDING_VALIDATION", "SUBMITTED"] } });
  });

  test("liste toProcess : statuts sans décision, jamais filtrée sur le compte du responsable", async () => {
    RawMaterialRequest.findAndCountAll.mockResolvedValue({ rows: [stored({ status: "SUBMITTED", deadlineAt: null })], count: 1 });
    const res = await request(app).get("/raw-material-requests").query({ toProcess: true, pageSize: 200 }).set("Authorization", bearer(VALIDATOR));
    expect(res.status).toBe(200);
    expect(RawMaterialRequest.findAndCountAll.mock.calls[0][0].where).toEqual({ status: { [Op.in]: ["PENDING_VALIDATION", "SUBMITTED"] } });
    expect(res.body.data[0]).toMatchObject({ status: "SUBMITTED", userEmail: PROD1.email });
  });

  test("toProcess pour production_1 : uniquement ses demandes", async () => {
    RawMaterialRequest.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    await request(app).get("/raw-material-requests").query({ toProcess: true }).set("Authorization", bearer(PROD1));
    expect(RawMaterialRequest.findAndCountAll.mock.calls[0][0].where).toEqual({ userId: PROD1.sub, status: { [Op.in]: ["PENDING_VALIDATION", "SUBMITTED"] } });
  });

  test("responsable : valide une demande « Soumise » (auteur, date, historique)", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(stored({ status: "SUBMITTED" })).mockResolvedValueOnce(stored({ status: "VALIDATED" }));
    const res = await request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(VALIDATOR)).send({ status: "VALIDATED" });
    expect(res.status).toBe(200);
    expect(RawMaterialRequest.update.mock.calls[0][0]).toMatchObject({ status: "VALIDATED", validatedBy: VALIDATOR.sub, validatedByEmail: VALIDATOR.email });
    expect(RawMaterialRequest.update.mock.calls[0][1].where).toEqual({ id: REQ_ID, status: "SUBMITTED" });
    expect(History.create.mock.calls[0][0]).toMatchObject({ fromStatus: "SUBMITTED", toStatus: "VALIDATED", changedBy: VALIDATOR.sub });
    // Le demandeur est notifié de la décision, comme pour une demande en attente.
    expect(notify.notifyDecision).toHaveBeenCalledWith(expect.anything(), { status: "VALIDATED", comment: null, byEmail: VALIDATOR.email });
  });

  test("responsable : rejet d'une demande « Soumise » sans motif refusé, avec motif accepté", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ status: "SUBMITTED" }));
    let res = await request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(VALIDATOR)).send({ status: "REJECTED" });
    expect(res.status).toBe(400);
    res = await request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(VALIDATOR)).send({ status: "REJECTED", comment: "Quantités à revoir" });
    expect(res.status).toBe(200);
    expect(RawMaterialRequest.update.mock.calls[0][0]).toMatchObject({ status: "REJECTED", rejectedBy: VALIDATOR.sub, rejectionComment: "Quantités à revoir" });
  });

  test("production_1 ne valide jamais sa demande « Soumise » ; production_2 ne la voit pas", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored({ status: "SUBMITTED" }));
    expect((await request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(PROD1)).send({ status: "VALIDATED" })).status).toBe(403);
    RawMaterialRequest.findOne.mockResolvedValue(null);
    expect((await request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(PROD2)).send({ status: "VALIDATED" })).status).toBe(404);
  });

  test("superadmin : droits existants conservés sur une demande « Soumise »", async () => {
    RawMaterialRequest.findOne.mockResolvedValueOnce(stored({ status: "SUBMITTED" })).mockResolvedValueOnce(stored({ status: "VALIDATED" }));
    expect((await request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(ADMIN)).send({ status: "VALIDATED" })).status).toBe(200);
  });
});

// ── Shift soir : prise en charge d'une demande validée ────────────────────
describe("Shift soir (production_2) : quantités réelles, acceptation, refus", () => {
  const validated = (over = {}) => stored({ status: "VALIDATED", validatedAt: "2026-10-30T10:15:00.000Z", validatedByEmail: VALIDATOR.email, ...over });
  const accept = (u, actualItems) => request(app).post(`/raw-material-requests/${REQ_ID}/evening-accept`).set("Authorization", bearer(u)).send({ actualItems });
  const refuse = (u, body) => request(app).post(`/raw-material-requests/${REQ_ID}/evening-refuse`).set("Authorization", bearer(u)).send(body);
  const ACTUALS = [{ material: "ISO", quantiteReelle: 18.5 }, { material: "FIBRE", quantiteReelle: 0 }];

  test("permissions : production_2 voit les demandes validées et peut les prendre en charge", async () => {
    const p2 = (await request(app).get("/raw-material-requests/permissions").set("Authorization", bearer(PROD2))).body.data;
    expect(p2).toMatchObject({ canView: true, canEveningHandle: true, fullVisibility: false, canValidate: false });
    const p1 = (await request(app).get("/raw-material-requests/permissions").set("Authorization", bearer(PROD1))).body.data;
    expect(p1.canEveningHandle).toBe(false);
  });

  test("liste du shift soir : demandes validées par le responsable, quel que soit le demandeur", async () => {
    RawMaterialRequest.findAndCountAll.mockResolvedValue({ rows: [validated()], count: 1 });
    const res = await request(app).get("/raw-material-requests").query({ status: "VALIDATED" }).set("Authorization", bearer(PROD2));
    expect(res.status).toBe(200);
    const where = RawMaterialRequest.findAndCountAll.mock.calls[0][0].where;
    expect(where.status).toBe("VALIDATED");
    expect(where[Op.or]).toBeDefined();
    expect(res.body.data[0]).toMatchObject({ requestNumber: "DMP-2026-000002", validatedByEmail: VALIDATOR.email, userEmail: PROD1.email });
  });

  test("détail : prise en charge proposée au shift soir pour une demande validée", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(validated());
    const res = await request(app).get(`/raw-material-requests/${REQ_ID}`).set("Authorization", bearer(PROD2));
    expect(res.body.data).toMatchObject({ status: "VALIDATED", canEveningHandle: true, actualItems: null });
  });

  test("Accepter : quantités réelles enregistrées par matière, auteur et date ; validation logistique conservée", async () => {
    at(new Date("2026-10-30T15:30:00Z"));
    RawMaterialRequest.findOne.mockResolvedValueOnce(validated()).mockResolvedValueOnce(validated({ status: "EVENING_ACCEPTED" }));
    const res = await accept(PROD2, ACTUALS);
    expect(res.status).toBe(200);
    const [changes, opts] = RawMaterialRequest.update.mock.calls[0];
    expect(changes).toEqual({
      status: "EVENING_ACCEPTED",
      actualItems: [
        { material: "ISO", label: "ISO", quantiteReelle: 18.5, unite: "KG" },
        { material: "FIBRE", label: "FIBRE", quantiteReelle: 0, unite: "KG" },
      ],
      eveningHandledAt: new Date("2026-10-30T15:30:00Z"),
      eveningHandledBy: PROD2.sub,
      eveningHandledByEmail: PROD2.email,
    });
    // Jamais les lignes validées ni la validation logistique.
    for (const k of ["items", "validatedAt", "validatedBy", "validatedByEmail"]) expect(changes).not.toHaveProperty(k);
    expect(opts.where).toEqual({ id: REQ_ID, status: "VALIDATED" });
    expect(History.create.mock.calls[0][0]).toMatchObject({ fromStatus: "VALIDATED", toStatus: "EVENING_ACCEPTED", changedBy: PROD2.sub });
    expect(History.create.mock.calls[0][0].comment).toBe("Prise en charge par le shift soir — quantités réelles : ISO 18.5 KG, FIBRE 0 KG");
  });

  test.each([
    ["quantité réelle manquante pour une matière", [{ material: "ISO", quantiteReelle: 3 }], 400, /manquante pour : FIBRE/],
    ["matière absente de la demande", [...ACTUALS, { material: "RESINE", quantiteReelle: 1 }], 400, /absente de la demande : RESINE/],
  ])("Accepter refusé : %s", async (_l, items, status, msg) => {
    RawMaterialRequest.findOne.mockResolvedValue(validated());
    const res = await accept(PROD2, items);
    expect(res.status).toBe(status);
    expect(res.body.message).toMatch(msg);
    expect(RawMaterialRequest.update).not.toHaveBeenCalled();
  });

  test.each([
    ["négative", -1, /négative/],
    ["non numérique", "abc", /nombre valide/],
    ["absente", undefined, /obligatoire/],
  ])("quantité réelle %s refusée (400)", async (_l, value, msg) => {
    const res = await accept(PROD2, [{ material: "ISO", quantiteReelle: value }, { material: "FIBRE", quantiteReelle: 0 }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(msg);
  });

  test("déjà acceptée : impossible d'accepter ou de refuser une 2e fois (409)", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(validated({ status: "EVENING_ACCEPTED" }));
    expect((await accept(PROD2, ACTUALS)).body.code).toBe("ALREADY_HANDLED");
    expect((await refuse(PROD2, { comment: "x" })).body.code).toBe("ALREADY_HANDLED");
    expect(RawMaterialRequest.update).not.toHaveBeenCalled();
  });

  test("deux prises en charge simultanées : la 2e est refusée (409), rien d'écrit", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(validated());
    RawMaterialRequest.update.mockResolvedValue([0]);
    const res = await accept(PROD2, ACTUALS);
    expect(res.status).toBe(409);
    expect(History.create).not.toHaveBeenCalled();
  });

  test("demande non validée (en attente) : jamais prise en charge par le shift soir", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(stored()); // En attente de validation
    const res = await accept(PROD2, ACTUALS);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_VALIDATED");
  });

  test("Refuser : motif obligatoire ; puis motif, auteur, date enregistrés et responsable notifié", async () => {
    let res = await refuse(PROD2, { comment: "   " });
    expect(res.status).toBe(400);
    RawMaterialRequest.findOne.mockResolvedValueOnce(validated()).mockResolvedValueOnce(validated({ status: "EVENING_REFUSED" }));
    res = await refuse(PROD2, { comment: "Stock ISO insuffisant ce soir" });
    expect(res.status).toBe(200);
    expect(RawMaterialRequest.update.mock.calls[0][0]).toMatchObject({
      status: "EVENING_REFUSED",
      eveningRefusalComment: "Stock ISO insuffisant ce soir",
      eveningHandledBy: PROD2.sub,
      eveningHandledByEmail: PROD2.email,
    });
    expect(History.create.mock.calls[0][0]).toMatchObject({ fromStatus: "VALIDATED", toStatus: "EVENING_REFUSED", comment: "Stock ISO insuffisant ce soir" });
    expect(notify.notifyEveningRefused).toHaveBeenCalledWith(expect.anything(), { comment: "Stock ISO insuffisant ce soir", byEmail: PROD2.email });
  });

  test.each([
    ["production_1 (demandeur)", PROD1],
    ["responsable logistique", VALIDATOR],
    ["superadmin", ADMIN],
    ["production_3", PROD3],
  ])("%s ne peut pas accepter ni refuser à la place du shift soir (403)", async (_l, u) => {
    expect((await accept(u, ACTUALS)).status).toBe(403);
    expect((await refuse(u, { comment: "x" })).status).toBe(403);
    expect(RawMaterialRequest.update).not.toHaveBeenCalled();
  });

  test("le changement de statut générique ne permet pas de contourner la prise en charge", async () => {
    RawMaterialRequest.findOne.mockResolvedValue(validated());
    const res = await request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(VALIDATOR)).send({ status: "EVENING_ACCEPTED" });
    expect(res.status).toBe(409);
    const p2 = await request(app).patch(`/raw-material-requests/${REQ_ID}/status`).set("Authorization", bearer(PROD2)).send({ status: "PROCESSED" });
    expect(p2.status).toBe(403);
  });

  test("export Excel : colonne « Quantité réelle (KG) » renseignée après prise en charge", async () => {
    RawMaterialRequest.findAll.mockResolvedValue([
      validated({ status: "EVENING_ACCEPTED", actualItems: [{ material: "ISO", quantiteReelle: 18.5 }, { material: "FIBRE", quantiteReelle: 0 }] }),
    ]);
    const res = await request(app)
      .get("/raw-material-requests/export")
      .set("Authorization", bearer(VALIDATOR))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(12).value).toBe("Quantité réelle (KG)");
    expect([ws.getRow(2).getCell(11).value, ws.getRow(2).getCell(12).value]).toEqual([20, 18.5]);
    expect([ws.getRow(3).getCell(11).value, ws.getRow(3).getCell(12).value]).toEqual([5.5, 0]);
    expect(ws.getRow(2).getCell(14).value).toBe("Acceptée par le shift soir");
  });
});
