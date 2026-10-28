"use strict";

// Notifications du circuit de validation des demandes de matières premières
// (modèles et file d'emails simulés).

jest.mock("../src/db", () => ({ sequelize: {} }));
jest.mock("../src/models/User", () => ({ findAll: jest.fn() }));
jest.mock("../src/models/Notification", () => ({ create: jest.fn() }));
jest.mock("../src/services/emailQueue.service", () => ({ enqueueEmailOnce: jest.fn() }));

const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const { enqueueEmailOnce } = require("../src/services/emailQueue.service");
const notify = require("../src/modules/raw-material-requests/services/rawMaterialRequestNotify.service");

const VALIDATOR = { id: "b4a9bf6f-65f1-4dd7-9a38-bb7a07210641", email: "responsable_logistique@cbi-tunisia.com" };
const row = {
  id: "66666666-6666-4666-8666-666666666666",
  requestNumber: "DMP-2026-000002",
  userId: "dd746847-c5ad-42e9-a5ab-4a721a0e3839",
  userEmail: "production_1@cbi-tunisia.com",
  poste: "matin",
  productionDate: "2026-10-30",
  deadlineAt: "2026-10-30T13:00:00.000Z",
  updatedAt: "2026-10-30T08:00:00.000Z",
  items: [{ label: "ISO", quantiteDemandee: 20, quantiteDisponible: 10, besoinProduction: 30, unite: "KG" }],
};

beforeEach(() => {
  jest.clearAllMocks();
  User.findAll.mockResolvedValue([VALIDATOR]);
  Notification.create.mockResolvedValue({});
  enqueueEmailOnce.mockResolvedValue({ status: "PENDING" });
});

test("soumission : notification et email aux responsables (logistique et production), avec l'échéance et les matières", async () => {
  await notify.notifySubmitted(row);
  expect(User.findAll.mock.calls[0][0].where).toEqual({ email: ["responsable_logistique@cbi-tunisia.com", "responsable_production@cbi-tunisia.com"] });
  expect(Notification.create).toHaveBeenCalledTimes(1);
  expect(Notification.create.mock.calls[0][0]).toMatchObject({ userId: VALIDATOR.id, type: "raw_material_request" });
  expect(Notification.create.mock.calls[0][0].message).toContain("30/10/2026 14:00");
  const mail = enqueueEmailOnce.mock.calls[0][0];
  expect(mail.to).toBe("responsable_logistique@cbi-tunisia.com");
  expect(mail.subject).toContain("DMP-2026-000002");
  expect(mail.text).toContain("ISO : demandé 20 KG");
  expect(mail.text).toContain("Validation requise avant : 30/10/2026 14:00");
});

test("décision : le demandeur est notifié avec le motif du rejet", async () => {
  await notify.notifyDecision(row, { status: "REJECTED", comment: "Quantité à revoir", byEmail: VALIDATOR.email });
  expect(Notification.create.mock.calls[0][0]).toMatchObject({ userId: row.userId, title: "Demande de matières premières rejetée" });
  expect(Notification.create.mock.calls[0][0].message).toContain("« Quantité à revoir »");
  expect(enqueueEmailOnce).not.toHaveBeenCalled();
});

test("retard : demandeur et responsable notifiés, email au responsable", async () => {
  await notify.notifyLate(row);
  expect(Notification.create.mock.calls.map((c) => c[0].userId)).toEqual([row.userId, VALIDATOR.id]);
  expect(enqueueEmailOnce.mock.calls[0][0].subject).toContain("en retard");
});

test("une erreur de notification ne remonte jamais (la demande reste enregistrée)", async () => {
  Notification.create.mockRejectedValue(new Error("db down"));
  await expect(notify.notifySubmitted(row)).resolves.toBeUndefined();
});

test("refus du shift soir : responsable logistique notifié (CRM + email) avec le motif", async () => {
  await notify.notifyEveningRefused(row, { comment: "Stock ISO insuffisant", byEmail: "production_2@cbi-tunisia.com" });
  expect(Notification.create.mock.calls[0][0]).toMatchObject({ userId: VALIDATOR.id, title: "Demande de matières premières refusée par le shift soir" });
  expect(Notification.create.mock.calls[0][0].message).toContain("« Stock ISO insuffisant »");
  const mail = enqueueEmailOnce.mock.calls[0][0];
  expect(mail.to).toBe("responsable_logistique@cbi-tunisia.com");
  expect(mail.subject).toContain("refusée par le shift soir");
  expect(mail.text).toContain("production_2@cbi-tunisia.com");
});
