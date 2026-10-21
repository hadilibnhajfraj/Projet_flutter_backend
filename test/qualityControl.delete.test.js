"use strict";

// Suppression d'une fiche de contrôle qualité — Super Admin UNIQUEMENT (rôle
// superadmin + compte racine, revérifiés en base). Suppression LOGIQUE :
// prélèvements, mesures, remarques et historique conservés ; fiches de
// production jamais touchées ; audit DELETE dans quality_control_history.
// Même squelette que test/qualityControl.comparison.test.js (mocks
// cron/mailer, DB réelle, fixtures uniques, nettoyage en afterAll).

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
  verifyConnection: jest.fn().mockResolvedValue({ ok: true }),
  maskEmail: (e) => e,
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const bcrypt = require("bcrypt");
const { QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");
const { signAccessToken } = require("../src/utils/tokens");
const { ROOT_ADMIN_EMAIL } = require("../src/config/rootAdmin");
const { rootAdminToken } = require("./helpers/rootAdminToken");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const RUN_ID = Date.now();
const DAY = "2035-05-10";
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = (u) => signAccessToken({ sub: u.id, email: u.email, role: u.role });
const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

describe("Contrôle Qualité — suppression réservée au Super Admin", () => {
  let qc;
  let root;
  let rootId;
  const tokens = {};
  const users = [];
  const created = [];

  async function make(type, machine, poste, { validate }) {
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qc))
      .send({
        productionType: type,
        machine,
        controlDate: DAY,
        controlTime: "09:30:00",
        productionDate: DAY,
        poste,
        remark: "remarque de test",
        items: [
          { parameterKey: "temperature_eau", value: "8", status: "CONFORME" },
          { parameterKey: type === "PROBAR" ? "viscosite_resine" : "temperature_machine", value: "180", status: "CONFORME" },
        ],
      });
    expect(res.status).toBe(201);
    created.push(res.body.data.id);
    if (validate) {
      const v = await request(app).post(`/quality-control/${res.body.data.id}/validate`).set(auth(qc)).send({ status: "CONFORME" });
      expect(v.status).toBe(200);
    }
    return res.body.data;
  }

  const del = (id, token) => {
    const r = request(app).delete(`/quality-control/${id}`);
    return token ? r.set(auth(token)) : r;
  };
  const statsTotal = async (type, machine) => {
    const s = (await request(app).get("/quality-control/stats?period=all").set(auth(root))).body.data;
    return s.lines.find((l) => l.type === type).machines.find((m) => m.machine === machine).total;
  };
  const listIds = async (query) => (await request(app).get(`/quality-control?limit=100&${query}`).set(auth(root))).body.data.map((c) => c.id);

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
    expect(qc).toBeTruthy();
    root = await rootAdminToken();
    rootId = (await User.findOne({ where: { email: ROOT_ADMIN_EMAIL } })).id;
    for (const role of ["superadmin", "superadmin2", "admin", "responsable_logistique_achat", "finance_production"]) {
      const u = await User.create({ email: `qc-del-${role}-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash("StrongPass123!", 4), isActive: true, role });
      users.push(u.id);
      tokens[role] = tokenFor(u);
    }
  }, 30000);

  afterAll(async () => {
    if (created.length) {
      const r = { replacements: { ids: created } };
      await sequelize.query(`DELETE FROM notifications WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_history WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_items WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_readings WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_controls WHERE id IN (:ids)`, r);
    }
    await User.destroy({ where: { id: users } });
    await sequelize.close();
  }, 30000);

  test("1/6/7 — le Super Admin supprime une fiche VALIDÉE : suppression logique, données liées conservées, audit, listes et compteurs à jour", async () => {
    const fiche = await make("PROMESH", "1", "matin", { validate: true });
    const before = await sql(
      `SELECT (SELECT COUNT(*)::int FROM quality_control_readings WHERE "qualityControlId" = :id) AS readings,
              (SELECT COUNT(*)::int FROM quality_control_items WHERE "qualityControlId" = :id) AS items,
              (SELECT COUNT(*)::int FROM quality_control_history WHERE "qualityControlId" = :id) AS history,
              (SELECT COUNT(*)::int FROM por_promesh) AS promesh,
              (SELECT COUNT(*)::int FROM industrial_records) AS records`,
      { id: fiche.id }
    );
    const totalBefore = await statsTotal("PROMESH", "1");
    expect(await listIds("productionType=PROMESH&machine=1")).toContain(fiche.id);

    const t0 = Date.now();
    const res = await del(fiche.id, root);
    expect(res.status).toBe(200);

    // Disparaît de la consultation, des listes (PROMESH / historique) et des compteurs.
    expect((await request(app).get(`/quality-control/${fiche.id}`).set(auth(root))).status).toBe(404);
    expect(await listIds("productionType=PROMESH&machine=1")).not.toContain(fiche.id);
    expect(await listIds(`search=${encodeURIComponent(fiche.reference)}`)).not.toContain(fiche.id);
    expect(await statsTotal("PROMESH", "1")).toBe(totalBefore - 1);

    // Suppression LOGIQUE : la ligne existe toujours, marquée supprimée par le Super Admin.
    const [row] = await sql(`SELECT "deletedAt", "deletedBy" FROM quality_controls WHERE id = :id`, { id: fiche.id });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(rootId);

    // Prélèvements, mesures et historique conservés (aucune cascade) ; production intacte.
    const after = await sql(
      `SELECT (SELECT COUNT(*)::int FROM quality_control_readings WHERE "qualityControlId" = :id) AS readings,
              (SELECT COUNT(*)::int FROM quality_control_items WHERE "qualityControlId" = :id) AS items,
              (SELECT COUNT(*)::int FROM por_promesh) AS promesh,
              (SELECT COUNT(*)::int FROM industrial_records) AS records`,
      { id: fiche.id }
    );
    expect(after[0]).toMatchObject({ readings: before[0].readings, items: before[0].items, promesh: before[0].promesh, records: before[0].records });

    // Audit : Super Admin, fiche concernée, date/heure.
    const audit = await sql(`SELECT * FROM quality_control_history WHERE "qualityControlId" = :id AND action = 'DELETE'`, { id: fiche.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: rootId, userEmail: ROOT_ADMIN_EMAIL });
    expect(audit[0].newValue).toContain(fiche.reference);
    expect(new Date(audit[0].changedAt).getTime()).toBeGreaterThanOrEqual(t0 - 60000);

    // Déjà supprimée → 404.
    expect((await del(fiche.id, root)).status).toBe(404);
  });

  test("1 — le Super Admin supprime aussi un BROUILLON (PROBAR)", async () => {
    const fiche = await make("PROBAR", "2", "matin", { validate: false });
    expect((await del(fiche.id, root)).status).toBe(200);
    expect(await listIds("productionType=PROBAR&machine=2")).not.toContain(fiche.id);
  });

  test("2/3/4 — controle_qualite, Production, admin, superadmin2, superadmin non racine, sans jeton : refusés, fiche intacte", async () => {
    const fiche = await make("PROMESH", "2", "soir", { validate: false });

    const qcRes = await del(fiche.id, qc); // même sur SON brouillon
    expect(qcRes.status).toBe(403);
    expect(qcRes.body.code).toBe("PERMISSION_DENIED");
    for (const role of ["superadmin", "superadmin2", "admin", "responsable_logistique_achat", "finance_production"]) {
      expect({ role, status: (await del(fiche.id, tokens[role])).status }).toEqual({ role, status: 403 });
    }
    expect((await del(fiche.id)).status).toBe(401);

    // JWT valide mais "falsifié" : email racine + rôle superadmin sur un AUTRE compte → revérifié en base → 403.
    const impostor = signAccessToken({ sub: users[0], email: ROOT_ADMIN_EMAIL, role: "superadmin" });
    expect((await del(fiche.id, impostor)).status).toBe(403);

    // Rien n'a été supprimé ni audité.
    const [row] = await sql(`SELECT "deletedAt" FROM quality_controls WHERE id = :id`, { id: fiche.id });
    expect(row.deletedAt).toBeNull();
    expect(await sql(`SELECT 1 FROM quality_control_history WHERE "qualityControlId" = :id AND action = 'DELETE'`, { id: fiche.id })).toHaveLength(0);
    expect((await request(app).get(`/quality-control/${fiche.id}`).set(auth(qc))).status).toBe(200);
  });

  test("5 — fiche inexistante ou identifiant invalide → 404", async () => {
    const missing = await del("00000000-0000-4000-8000-000000000000", root);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("NOT_FOUND");
    expect((await del("pas-un-uuid", root)).status).toBe(404);
  });

  test("8 — création, modification, validation et consultation inchangées pour controle_qualite", async () => {
    const fiche = await make("PROBAR", "3", "soir", { validate: false });
    const edit = await request(app).put(`/quality-control/${fiche.id}`).set(auth(qc)).send({ remark: "modifiée" });
    expect(edit.status).toBe(200);
    const v = await request(app).post(`/quality-control/${fiche.id}/validate`).set(auth(qc)).send({ status: "CONFORME" });
    expect(v.status).toBe(200);
    expect(v.body.data.isValidated).toBe(true);
    expect((await request(app).get(`/quality-control/${fiche.id}`).set(auth(qc))).status).toBe(200);
    // Toujours en lecture seule après validation pour controle_qualite.
    expect((await request(app).put(`/quality-control/${fiche.id}`).set(auth(qc)).send({ remark: "x" })).status).toBe(403);
  });
});
