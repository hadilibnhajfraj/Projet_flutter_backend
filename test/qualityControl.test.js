"use strict";

// Module CONTRÔLE QUALITÉ — parcours complet avec le compte réel
// controle_qualite@cbi-tunisia.com (seeder controle-qualite.seeder.js) sur
// une fiche de production RÉELLE existante (lue, jamais modifiée).
// Même squelette que finance.access.test.js (mocks cron/mailer, DB réelle,
// nettoyage en afterAll).

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const bcrypt = require("bcrypt");

const RUN_ID = Date.now();
const MANAGER_EMAIL = `qc-manager-${RUN_ID}@example.com`;
// Destinataire des notifications isolé pour le test (lu à l'exécution).
process.env.QUALITY_CONTROL_NOTIFY_RECIPIENTS = MANAGER_EMAIL;

const app = require("../src/app");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const PorPromesh = require("../src/models/PorPromesh");
const IndustrialRecord = require("../src/models/IndustrialRecord");
const qcService = require("../src/modules/quality-control/services/qualityControl.service");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const PASSWORD = "StrongPass123!";
const EXPECTED_LABELS = [
  "HEURE",
  "NIVEAU BAIN DE GRAINES",
  "DIAMÈTRE DE BAR",
  "TEMPÉRATURE DE MACHINE",
  "TEMPÉRATURE D'EAU",
  "PRESSION D'AIR COMPRIMÉ",
  "ÉTAT D'IMPRESSION",
  "NOMBRE DE BAR EN LONGUEUR",
  "DIMENSIONS DE MAILLE",
  "DIMENSIONS COTE 1 LONG",
  "DIMENSIONS COTE 2 LONG",
  "FUITE D'EAU",
  "FUITE D'AIR COMPRIMÉ",
  "ÉTAT DISQUE DE COUPE",
  "NOMBRE DE BAR EN LARGEUR",
];

const createdUserIds = [];
const createdControlIds = [];

async function createTestUser(role, email) {
  const user = await User.create({ email, passwordHash: await bcrypt.hash(PASSWORD, 12), isActive: true, role });
  createdUserIds.push(user.id);
  return user;
}

async function signIn(email, password = PASSWORD) {
  const res = await request(app).post("/auth/signin").send({ email, password });
  return res.body;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe("Contrôle qualité — checklist de production", () => {
  let qcToken;
  let qcUser;
  let otherQcToken;
  let adminToken;
  let manager;
  let fiche; // { type, id, snapshot }
  let promeshFicheBefore;

  beforeAll(async () => {
    const qcSignin = await signIn(QC_EMAIL, QC_PASSWORD);
    qcToken = qcSignin.accessToken;
    qcUser = qcSignin.user;

    const otherQc = await createTestUser("controle_qualite", `qc-other-${RUN_ID}@example.com`);
    const admin = await createTestUser("superadmin", `qc-admin-${RUN_ID}@example.com`);
    manager = await createTestUser("user", MANAGER_EMAIL);
    otherQcToken = (await signIn(otherQc.email)).accessToken;
    adminToken = (await signIn(admin.email)).accessToken;

    const promesh = await PorPromesh.findOne({ order: [["createdAt", "DESC"]] });
    if (promesh) {
      fiche = { type: "PROMESH", id: promesh.id };
      promeshFicheBefore = promesh.toJSON();
    } else {
      const probar = await IndustrialRecord.findOne({ where: { module: "probar" }, order: [["createdAt", "DESC"]] });
      fiche = { type: "PROBAR", id: probar.id };
    }
  }, 30000);

  afterAll(async () => {
    qcService.setClock(null);
    if (createdControlIds.length) {
      const ids = { replacements: { ids: createdControlIds } };
      await Notification.destroy({ where: { qualityControlId: createdControlIds } });
      await sequelize.query(`DELETE FROM quality_control_history WHERE "qualityControlId" IN (:ids)`, ids);
      await sequelize.query(`DELETE FROM quality_control_items WHERE "qualityControlId" IN (:ids)`, ids);
      await sequelize.query(`DELETE FROM quality_controls WHERE id IN (:ids)`, ids);
    }
    await Notification.destroy({ where: { userId: createdUserIds } });
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  // ── Connexion / RBAC ────────────────────────────────────────────────────

  test("connexion avec controle_qualite@cbi-tunisia.com (rôle controle_qualite)", () => {
    expect(qcToken).toBeTruthy();
    expect(qcUser.role).toBe("controle_qualite");
  });

  test("accès au module : les 15 paramètres avec les intitulés exacts", async () => {
    const res = await request(app).get("/quality-control/parameters").set(auth(qcToken));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.label)).toEqual(EXPECTED_LABELS);
  });

  test("consultation des fiches de production (lecture seule)", async () => {
    const list = await request(app).get("/production-records").set(auth(qcToken));
    expect(list.status).toBe(200);
    const detail = await request(app).get(`/production-records/${fiche.type.toLowerCase()}:${fiche.id}`).set(auth(qcToken));
    expect(detail.status).toBe(200);
  });

  test.each([
    ["put", `/por-promesh/00000000-0000-0000-0000-000000000000`],
    ["delete", `/por-promesh/00000000-0000-0000-0000-000000000000`],
    ["put", `/industrial-records/00000000-0000-0000-0000-000000000000`],
    ["delete", `/industrial-records/00000000-0000-0000-0000-000000000000`],
    ["get", "/users"],
    ["get", "/admin/users"],
    ["get", "/production-records/summary"],
    ["get", "/finance/dashboard"],
  ])("controle_qualite refusé (403) sur %s %s", async (method, path) => {
    const res = await request(app)[method](path).set(auth(qcToken)).send({});
    expect(res.status).toBe(403);
  });

  test("un rôle sans accès reçoit 403 sur /quality-control", async () => {
    const res = await request(app).get("/quality-control").set(auth((await signIn(MANAGER_EMAIL)).accessToken));
    expect(res.status).toBe(403);
  });

  test("requête non authentifiée : 401", async () => {
    const res = await request(app).get("/quality-control");
    expect(res.status).toBe(401);
  });

  // ── Parcours complet ────────────────────────────────────────────────────

  let controlId;

  test("création liée à la fiche réelle — date/utilisateur/fiche posés par le serveur", async () => {
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qcToken))
      .send({
        productionRecordId: `${fiche.type.toLowerCase()}:${fiche.id}`,
        // Tentatives de falsification — doivent être ignorées.
        controllerEmail: "pirate@example.com",
        checkedAt: "2000-01-01T00:00:00Z",
        machine: "99",
        items: [{ parameterKey: "temperature_machine", value: "185 °C", status: "CONFORME" }],
      });
    expect(res.status).toBe(201);
    const c = res.body.data;
    createdControlIds.push(c.id);
    controlId = c.id;

    expect(c.controllerEmail).toBe(QC_EMAIL);
    expect(c.controllerUserId).toBe(qcUser.id);
    expect(c.productionType).toBe(fiche.type);
    expect(c.productionRecordId).toBe(fiche.id);
    expect(c.machine).not.toBe("99");
    expect(c.checkedAt).toBeNull();
    expect(c.status).toBe("EN_COURS");
    expect(c.items).toHaveLength(15);
    expect(c.items.map((i) => i.parameterName)).toEqual(EXPECTED_LABELS);
    if (fiche.type === "PROMESH") expect(c.ficheNumero).toMatch(/^PROMESH-\d{4}-\d{6}$/);
  });

  test("la fiche de production n'est jamais modifiée par le contrôle", async () => {
    if (!promeshFicheBefore) return;
    const after = (await PorPromesh.findByPk(fiche.id)).toJSON();
    expect(after.updatedAt).toEqual(promeshFicheBefore.updatedAt);
  });

  test("validation refusée si un paramètre non conforme n'a pas de remarque", async () => {
    const res = await request(app)
      .post(`/quality-control/${controlId}/validate`)
      .set(auth(qcToken))
      .send({ items: [{ parameterKey: "temperature_eau", value: "28.5 °C", status: "NON_CONFORME" }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors.some((e) => e.parameterKey === "temperature_eau")).toBe(true);
    // Transaction annulée : rien n'a été enregistré.
    const detail = await request(app).get(`/quality-control/${controlId}`).set(auth(qcToken));
    expect(detail.body.data.items.find((i) => i.parameterKey === "temperature_eau").value).toBeNull();
  });

  test("validation CONFORME — date/heure automatiques en heure de Tunisie", async () => {
    // 13:36:27 UTC = 14:36:27 à Tunis (UTC+1, pas d'heure d'été).
    qcService.setClock(() => new Date("2026-09-25T13:36:27Z"));
    const res = await request(app)
      .post(`/quality-control/${controlId}/validate`)
      .set(auth(qcToken))
      .send({ status: "CONFORME", items: [{ parameterKey: "fuite_eau", value: "Aucune", status: "CONFORME" }] });
    qcService.setClock(null);

    expect(res.status).toBe(200);
    const c = res.body.data;
    expect(c.status).toBe("CONFORME");
    expect(c.controlDate).toBe("25/09/2026");
    expect(c.controlTime).toBe("14:36:27");
    expect(new Date(c.checkedAt).toISOString()).toBe("2026-09-25T13:36:27.000Z");
    // HEURE pré-remplie automatiquement.
    expect(c.items.find((i) => i.parameterKey === "heure").value).toBe("14:36");
    expect(c.counts).toMatchObject({ total: 15, controlled: 2, nonConformes: 0 });
    expect(res.body.data.notificationsSent).toBeUndefined();
  });

  test("un contrôle validé ne peut pas être revalidé", async () => {
    const res = await request(app).post(`/quality-control/${controlId}/validate`).set(auth(qcToken)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_VALIDATED");
  });

  test("modification d'un contrôle validé sans motif : refusée (jamais d'écrasement silencieux)", async () => {
    const res = await request(app)
      .put(`/quality-control/${controlId}`)
      .set(auth(qcToken))
      .send({ items: [{ parameterKey: "temperature_machine", value: "190 °C" }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHANGE_REASON_REQUIRED");
  });

  test("modification avec motif → NON CONFORME + traçabilité + notification", async () => {
    const res = await request(app)
      .put(`/quality-control/${controlId}`)
      .set(auth(qcToken))
      .send({
        changeReason: "Nouvelle mesure après réglage",
        items: [{ parameterKey: "temperature_machine", value: "210 °C", status: "NON_CONFORME", remark: "Surchauffe" }],
      });
    expect(res.status).toBe(200);
    const c = res.body.data;
    expect(c.status).toBe("NON_CONFORME");
    expect(c.nonConformParameters).toEqual(["TEMPÉRATURE DE MACHINE"]);
    expect(c.notificationsSent).toBe(1);

    const valueChange = c.history.find((h) => h.parameterKey === "temperature_machine" && h.field === "value" && h.newValue === "210 °C");
    expect(valueChange).toMatchObject({ oldValue: "185 °C", reason: "Nouvelle mesure après réglage", userEmail: QC_EMAIL });
    expect(valueChange.changedDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(valueChange.changedTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // L'ancienne valeur saisie à la création reste dans l'historique.
    expect(c.history.some((h) => h.action === "CREATE")).toBe(true);
    expect(c.history.some((h) => h.field === "status" && h.oldValue === "CONFORME" && h.newValue === "NON_CONFORME")).toBe(true);

    const notif = await Notification.findOne({ where: { userId: manager.id, qualityControlId: controlId } });
    expect(notif.title).toBe("Contrôle qualité non conforme");
    expect(notif.message).toContain(`Production : ${fiche.type}`);
    expect(notif.message).toContain("TEMPÉRATURE DE MACHINE");
    expect(notif.message).toContain(QC_EMAIL);
  });

  test("un paramètre NON CONFORME force NON CONFORME même si CONFORME est demandé", async () => {
    const created = await request(app)
      .post("/quality-control")
      .set(auth(qcToken))
      .send({ productionRecordId: fiche.id, productionType: fiche.type });
    createdControlIds.push(created.body.data.id);
    expect(created.body.data.status).toBe("EN_ATTENTE");

    const res = await request(app)
      .post(`/quality-control/${created.body.data.id}/validate`)
      .set(auth(qcToken))
      .send({
        status: "CONFORME",
        items: [
          { parameterKey: "temperature_eau", value: "28.5 °C", status: "NON_CONFORME", remark: "Température légèrement supérieure à la valeur habituelle" },
          { parameterKey: "pression_air_comprime", value: "6 bar", status: "CONFORME" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("NON_CONFORME");
    expect(res.body.data.counts).toMatchObject({ controlled: 2, nonConformes: 1 });
    expect(res.body.data.notificationsSent).toBe(1);
  });

  test("historique : liste avec compteurs + recherche par fiche", async () => {
    const list = await request(app).get("/quality-control").set(auth(qcToken));
    expect(list.status).toBe(200);
    const row = list.body.data.find((c) => c.id === controlId);
    expect(row).toMatchObject({ productionType: fiche.type, controllerEmail: QC_EMAIL, status: "NON_CONFORME" });
    expect(row.counts.controlled).toBeGreaterThan(0);
    expect(row.items).toBeUndefined();

    const byFiche = await request(app).get(`/quality-control/production/${fiche.type.toLowerCase()}:${fiche.id}`).set(auth(qcToken));
    expect(byFiche.status).toBe(200);
    expect(byFiche.body.data.map((c) => c.id)).toEqual(expect.arrayContaining(createdControlIds));
  });

  test("un contrôleur ne voit pas les contrôles d'un autre", async () => {
    const res = await request(app).get(`/quality-control/${controlId}`).set(auth(otherQcToken));
    expect(res.status).toBe(403);
    const list = await request(app).get("/quality-control").set(auth(otherQcToken));
    expect(list.body.data.some((c) => c.id === controlId)).toBe(false);
  });

  test("suppression interdite au contrôleur ; suppression logique par admin, historique conservé", async () => {
    expect((await request(app).delete(`/quality-control/${controlId}`).set(auth(qcToken))).status).toBe(403);

    const del = await request(app).delete(`/quality-control/${controlId}`).set(auth(adminToken));
    expect(del.status).toBe(200);
    expect((await request(app).get(`/quality-control/${controlId}`).set(auth(adminToken))).status).toBe(404);

    const [[row]] = await sequelize.query(`SELECT "deletedAt" FROM quality_controls WHERE id = :id`, { replacements: { id: controlId } });
    expect(row.deletedAt).not.toBeNull();
    const [history] = await sequelize.query(`SELECT action FROM quality_control_history WHERE "qualityControlId" = :id`, { replacements: { id: controlId } });
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["CREATE", "VALIDATE", "DELETE"]));
  });

  test("paramètre inconnu refusé", async () => {
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qcToken))
      .send({ productionRecordId: fiche.id, productionType: fiche.type, items: [{ parameterKey: "hauteur", value: "1" }] });
    expect(res.status).toBe(400);
  });
});
