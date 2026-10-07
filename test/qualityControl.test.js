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
// Paramètres d'un prélèvement : ceux de la configuration (catégories du formulaire).
// Paramètres affichables : ceux d'au moins une ligne (DIAMÈTRE DE LA BARRE est retiré).
const EXPECTED_LABELS = require("../src/config/qualityControl").parameters.filter((p) => p.lines.length > 0).map((p) => p.label);

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

    // Fiche sans contrôle qualité actif (un seul contrôle par fiche).
    const free = `NOT EXISTS (SELECT 1 FROM quality_controls q WHERE q."productionRecordId" = p.id AND q."deletedAt" IS NULL)`;
    const [row] = await sequelize.query(`SELECT p.id FROM por_promesh p WHERE ${free} ORDER BY p."createdAt" DESC LIMIT 1`, { type: "SELECT" });
    const promesh = row && (await PorPromesh.findByPk(row.id));
    if (promesh) {
      fiche = { type: "PROMESH", id: promesh.id };
      promeshFicheBefore = promesh.toJSON();
    } else {
      const [pb] = await sequelize.query(`SELECT p.id FROM industrial_records p WHERE p.module = 'probar' AND ${free} ORDER BY p."createdAt" DESC LIMIT 1`, { type: "SELECT" });
      const probar = await IndustrialRecord.findByPk(pb.id);
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

  test("accès au module : les paramètres d'un prélèvement avec les intitulés exacts (l'heure appartient au prélèvement)", async () => {
    const res = await request(app).get("/quality-control/parameters").set(auth(qcToken));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.label)).toEqual(EXPECTED_LABELS);
    expect(EXPECTED_LABELS).toHaveLength(41);
    expect(EXPECTED_LABELS).not.toContain("DIAMÈTRE DE BAR");
    expect(EXPECTED_LABELS).toEqual(expect.arrayContaining(["NIVEAU BAIN DE GRAINES", "QUALITÉ DE COUPE", "ÉTAT DU DISQUE DE COUPE"]));
    expect(EXPECTED_LABELS).not.toContain("OVALISATION");
    expect(EXPECTED_LABELS).not.toContain("HEURE");
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

  test("création d'une fiche qualité de MACHINE — date/utilisateur posés par le serveur, production jamais enregistrée", async () => {
    // Machine inconnue : refusée (jamais ignorée).
    const unknown = await request(app).post("/quality-control").set(auth(qcToken)).send({ productionType: fiche.type, machine: "99" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("INVALID_MACHINE");

    const res = await request(app)
      .post("/quality-control")
      .set(auth(qcToken))
      .send({
        productionType: fiche.type,
        machine: "1",
        // Tentatives de falsification — doivent être ignorées.
        productionRecordId: `${fiche.type.toLowerCase()}:${fiche.id}`,
        controllerEmail: "pirate@example.com",
        controllerUserId: "00000000-0000-0000-0000-000000000000",
        createdBy: "production_1@cbi-tunisia.com",
        checkedAt: "2000-01-01T00:00:00Z",
        items: [{ parameterKey: "temperature_machine", value: "185 °C", status: "CONFORME" }],
      });
    expect(res.status).toBe(201);
    const c = res.body.data;
    createdControlIds.push(c.id);
    controlId = c.id;

    expect(c.controllerEmail).toBe(QC_EMAIL);
    expect(c.controllerUserId).toBe(qcUser.id);
    expect(c.productionType).toBe(fiche.type);
    expect(c.productionRecordId).toBeNull(); // indépendante de la production
    expect(c.machine).toBe("1");
    expect(c.reference).toMatch(/^QC-(PROMESH|PROBAR)-\d{6}$/);
    expect(c.checkedAt).toBeNull();
    expect(c.status).toBe("EN_COURS");
    expect(c.items).toHaveLength(require("../src/config/qualityControl").readingParametersFor(fiche.type).length);
    // Un prélèvement porte les contrôles temporels ; les paramètres physiques sont au niveau de la fiche.
    expect(c.items.map((i) => i.parameterName)).toEqual(require("../src/config/qualityControl").readingParametersFor(fiche.type).map((p) => p.label));
    expect(c.physicalParameters.map((i) => i.parameterName)).toEqual(require("../src/config/qualityControl").physicalParameters(fiche.type).map((p) => p.label));
    expect(c.ficheNumero).toBeNull();
  });

  test("la fiche de production n'est jamais modifiée par le contrôle", async () => {
    if (!promeshFicheBefore) return;
    const after = (await PorPromesh.findByPk(fiche.id)).toJSON();
    expect(after.updatedAt).toEqual(promeshFicheBefore.updatedAt);
  });

  // Seules les DONNÉES obligatoires refusent une validation (jamais le
  // résultat Non conforme — voir qualityControl.module.test.js, TEST 2).
  test("validation refusée si un paramètre contrôlé n'a pas de valeur — transaction annulée", async () => {
    const res = await request(app)
      .post(`/quality-control/${controlId}/validate`)
      .set(auth(qcToken))
      .send({
        status: "NON_CONFORME",
        remark: "remarque qui ne doit pas être enregistrée",
        items: [
          { parameterKey: "temperature_eau", status: "CONFORME" },
          { parameterKey: "pression_air_comprime", value: "6", status: "CONFORME" },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors.some((e) => e.parameterKey === "temperature_eau")).toBe(true);
    // ROLLBACK : ni paramètres, ni remarque, ni statut enregistrés.
    const detail = (await request(app).get(`/quality-control/${controlId}`).set(auth(qcToken))).body.data;
    expect(detail.items.find((i) => i.parameterKey === "pression_air_comprime").value).toBeNull();
    expect(detail.remark).not.toBe("remarque qui ne doit pas être enregistrée");
    expect(detail.isValidated).toBe(false);
  });

  test("validation CONFORME — horodatage serveur en heure de Tunisie, date/heure d'ouverture conservées", async () => {
    const before = (await request(app).get(`/quality-control/${controlId}`).set(auth(qcToken))).body.data;
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
    // Date/heure d'OUVERTURE (modifiables par le contrôleur) : jamais
    // écrasées par la validation.
    expect(c.controlDate).toBe(before.controlDate);
    expect(c.controlTime).toBe(before.controlTime);
    // Horodatage de la validation (audit), posé par le serveur.
    expect(c.validatedDate).toBe("25/09/2026");
    expect(c.validatedTime).toBe("14:36:27");
    expect(new Date(c.checkedAt).toISOString()).toBe("2026-09-25T13:36:27.000Z");
    // L'heure du contrôle appartient au PRÉLÈVEMENT, validé avec la fiche.
    expect(c.readingsCount).toBe(1);
    expect(c.readings[0]).toMatchObject({ isValidated: true, status: "CONFORME" });
    expect(c.readings[0].readingTime).toMatch(/^\d{2}:\d{2}$/);
    expect(c.counts).toMatchObject({ total: require("../src/config/qualityControl").readingParametersFor(fiche.type).length, nonConformes: 0 });
    expect(res.body.data.notificationsSent).toBeUndefined();
  });

  // Contrôle VALIDÉ = lecture seule pour tous, appliqué par l'API.
  test("un contrôle validé ne peut pas être revalidé (403 lecture seule)", async () => {
    const res = await request(app).post(`/quality-control/${controlId}/validate`).set(auth(qcToken)).send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "CONTROL_LOCKED", message: "Un contrôle validé est en lecture seule et ne peut plus être modifié." });
  });

  test("modification d'un contrôle validé : 403, même avec un motif — rien n'est modifié", async () => {
    for (const body of [
      { items: [{ parameterKey: "temperature_machine", value: "190 °C" }] },
      { changeReason: "Nouvelle mesure", items: [{ parameterKey: "temperature_machine", value: "210 °C", status: "NON_CONFORME" }] },
      { poste: "soir" },
      { status: "NON_CONFORME", changeReason: "x" },
    ]) {
      const res = await request(app).put(`/quality-control/${controlId}`).set(auth(qcToken)).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("CONTROL_LOCKED");
    }
    const c = (await request(app).get(`/quality-control/${controlId}`).set(auth(qcToken))).body.data;
    expect(c.status).toBe("CONFORME");
    expect(c.items.find((i) => i.parameterKey === "temperature_machine").value).toBe("185 °C");
  });

  test("un paramètre NON CONFORME force NON CONFORME même si CONFORME est demandé", async () => {
    // Fiche distincte : un seul contrôle actif par fiche de production.
    const [free] = await sequelize.query(
      `SELECT p.id FROM por_promesh p WHERE NOT EXISTS (SELECT 1 FROM quality_controls q WHERE q."productionRecordId" = p.id AND q."deletedAt" IS NULL) ORDER BY p."createdAt" DESC LIMIT 1`,
      { type: "SELECT" }
    );
    const created = await request(app)
      .post("/quality-control")
      .set(auth(qcToken))
      .send({ productionType: "PROMESH", machine: "1" });
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
    // Notification interne (jamais d'email client) aux responsables Production.
    const notif = await Notification.findOne({ where: { userId: manager.id, qualityControlId: created.body.data.id } });
    expect(notif.title).toBe("Contrôle qualité non conforme");
    expect(notif.message).toContain("Production : PROMESH");
    expect(notif.message).toContain("TEMPÉRATURE D'EAU");
    expect(notif.message).toContain(QC_EMAIL);
  });

  test("historique : liste avec compteurs + recherche par référence de fiche qualité", async () => {
    const list = await request(app).get("/quality-control").set(auth(qcToken));
    expect(list.status).toBe(200);
    const row = list.body.data.find((c) => c.id === controlId);
    expect(row).toMatchObject({ productionType: fiche.type, controllerEmail: QC_EMAIL, status: "CONFORME", isValidated: true });
    expect(row.counts.controlled).toBeGreaterThan(0);
    expect(row.items).toBeUndefined();

    const byRef = await request(app).get(`/quality-control?search=${row.reference}`).set(auth(qcToken));
    expect(byRef.status).toBe(200);
    expect(byRef.body.data.map((c) => c.id)).toEqual([controlId]);
  });

  test("un contrôleur ne voit pas les contrôles d'un autre", async () => {
    const res = await request(app).get(`/quality-control/${controlId}`).set(auth(otherQcToken));
    expect(res.status).toBe(403);
    const list = await request(app).get("/quality-control").set(auth(otherQcToken));
    expect(list.body.data.some((c) => c.id === controlId)).toBe(false);
  });

  test("suppression : contrôle VALIDÉ refusé pour tous (403) ; BROUILLON supprimé (logique) par son contrôleur, historique conservé", async () => {
    for (const token of [qcToken, adminToken]) {
      const res = await request(app).delete(`/quality-control/${controlId}`).set(auth(token));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "CONTROL_LOCKED", message: "Un contrôle validé ne peut pas être supprimé." });
    }
    expect((await request(app).get(`/quality-control/${controlId}`).set(auth(qcToken))).status).toBe(200);

    const [free] = await sequelize.query(
      `SELECT p.id FROM por_promesh p WHERE NOT EXISTS (SELECT 1 FROM quality_controls q WHERE q."productionRecordId" = p.id AND q."deletedAt" IS NULL) ORDER BY p."createdAt" DESC LIMIT 1`,
      { type: "SELECT" }
    );
    const draft = (await request(app).post("/quality-control").set(auth(qcToken)).send({ productionType: "PROMESH", machine: "1" })).body.data;
    createdControlIds.push(draft.id);
    // Un autre contrôleur ne peut pas supprimer ce brouillon.
    expect((await request(app).delete(`/quality-control/${draft.id}`).set(auth(otherQcToken))).status).toBe(403);
    const del = await request(app).delete(`/quality-control/${draft.id}`).set(auth(qcToken));
    expect(del.status).toBe(200);
    expect((await request(app).get(`/quality-control/${draft.id}`).set(auth(qcToken))).status).toBe(404);

    const [[row]] = await sequelize.query(`SELECT "deletedAt" FROM quality_controls WHERE id = :id`, { replacements: { id: draft.id } });
    expect(row.deletedAt).not.toBeNull();
    const [history] = await sequelize.query(`SELECT action FROM quality_control_history WHERE "qualityControlId" = :id`, { replacements: { id: draft.id } });
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["CREATE", "DELETE"]));
    // La fiche de production reste disponible pour un nouveau contrôle.
    const again = await request(app).post("/quality-control").set(auth(qcToken)).send({ productionType: "PROMESH", machine: "1" });
    expect(again.status).toBe(201);
    createdControlIds.push(again.body.data.id);
  });

  test("paramètre inconnu refusé", async () => {
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qcToken))
      .send({ productionType: fiche.type, machine: "1", items: [{ parameterKey: "hauteur", value: "1" }] });
    expect(res.status).toBe(400);
  });
});
