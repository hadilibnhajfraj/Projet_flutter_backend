"use strict";

// Module CONTRÔLE QUALITÉ — parcours PROMESH (machines 1-4) / PROBAR avec le
// compte réel controle_qualite@cbi-tunisia.com, sur des fiches de production
// RÉELLES (lues, jamais modifiées). Relecture PostgreSQL. Les contrôles créés
// sont supprimés en afterAll.

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
const PorPromesh = require("../src/models/PorPromesh");
const IndustrialRecord = require("../src/models/IndustrialRecord");
const QualityControl = require("../src/models/QualityControl");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const RUN_ID = Date.now();
const createdControls = [];
const createdUsers = [];
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function itemValue(controlId, key) {
  const [r] = await sequelize.query(`SELECT value, status FROM quality_control_items WHERE "qualityControlId" = :id AND "parameterKey" = :k`, {
    replacements: { id: controlId, k: key },
    type: QueryTypes.SELECT,
  });
  return r;
}

describe("Contrôle Qualité — module PROMESH / PROBAR", () => {
  let qc;
  let adminToken;

  beforeAll(async () => {
    const s = await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD });
    qc = { token: s.body.accessToken, user: s.body.user };
    const admin = await User.create({ email: `qc-module-admin-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash("StrongPass123!", 12), isActive: true, role: "superadmin" });
    createdUsers.push(admin.id);
    adminToken = (await request(app).post("/auth/signin").send({ email: admin.email, password: "StrongPass123!" })).body.accessToken;

    // Fiches qualité créées par MACHINE : aucune fiche de production requise.
  }, 30000);

  afterAll(async () => {
    if (createdControls.length) {
      const r = { replacements: { ids: createdControls } };
      await sequelize.query(`DELETE FROM notifications WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_history WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_control_items WHERE "qualityControlId" IN (:ids)`, r);
      await sequelize.query(`DELETE FROM quality_controls WHERE id IN (:ids)`, r);
    }
    await User.destroy({ where: { id: createdUsers } });
    await sequelize.close();
  }, 30000);

  test("TEST 1 — connexion controle_qualite (rôle dédié, jamais admin)", () => {
    expect(qc.token).toBeTruthy();
    expect(qc.user.role).toBe("controle_qualite");
  });

  test("TEST 3/4/19/20 — config : PROMESH et PROBAR avec les machines 1 à 4 du module Production", async () => {
    const res = await request(app).get("/quality-control/config").set(auth(qc.token));
    expect(res.status).toBe(200);
    const lines = Object.fromEntries(res.body.data.productionLines.map((l) => [l.type, l.machines]));
    expect(lines).toEqual({ PROMESH: ["1", "2", "3", "4"], PROBAR: ["1", "2", "3", "4"] });
    const params = res.body.data.parameters;
    // 41 paramètres affichables (les paramètres retirés de toutes les lignes ne sont plus renvoyés).
    expect(params).toHaveLength(41);
    expect(params.every((p) => p.lines.length > 0)).toBe(true);
    // Contrôles d'un prélèvement PAR LIGNE : PROMESH 8 (contrôle machine), PROBAR 15 (chaque ligne a sa propre liste).
    expect(params.filter((p) => p.scope === "reading" && p.lines.includes("PROMESH"))).toHaveLength(8);
    expect(params.filter((p) => p.scope === "reading" && p.lines.includes("PROBAR"))).toHaveLength(15);
    expect(params.filter((p) => p.scope === "fiche" && p.lines.includes("PROMESH"))).toHaveLength(7); // PROMESH : contrôle produit (niveau fiche)
    expect(params.filter((p) => p.scope === "fiche" && p.lines.includes("PROBAR"))).toHaveLength(7);
    expect(params.find((p) => p.key === "pression_air_comprime")).toMatchObject({ section: "machine", unit: "bar" });
    expect(params.find((p) => p.key === "etat_disque_coupe").options.map((o) => o.value)).toEqual(["OK", "NOK"]);
  });

  test("TEST 6 — sélection d'une production : fiches filtrées par ligne et machine", async () => {
    const res = await request(app).get("/production-records?type=promesh&machineId=1&limit=5").set(auth(qc.token));
    expect(res.status).toBe(200);
    expect(res.body.data.every((f) => f.type === "promesh" && String(f.machine) === "1")).toBe(true);
  });

  let control1;

  test("TEST 5/7 — PROMESH Machine 1 : nouvelle fiche qualité de la machine (aucune fiche de production créée ni requise)", async () => {
    const [{ n: before }] = await sequelize.query(`SELECT count(*)::int n FROM por_promesh`, { type: QueryTypes.SELECT });
    const res = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "1" });
    expect(res.status).toBe(201);
    control1 = res.body.data.id;
    createdControls.push(control1);
    expect(res.body.data).toMatchObject({ productionType: "PROMESH", machine: "1", controllerEmail: QC_EMAIL, status: "EN_ATTENTE" });
    expect(res.body.data.items.every((i) => i.value === null && i.status === "NON_CONTROLE")).toBe(true); // création : vide
    const [{ n: after }] = await sequelize.query(`SELECT count(*)::int n FROM por_promesh`, { type: QueryTypes.SELECT });
    expect(after).toBe(before);
  });

  test("TEST 8/9 — paramètres remplis puis enregistrés (PostgreSQL)", async () => {
    const res = await request(app)
      .put(`/quality-control/${control1}`)
      .set(auth(qc.token))
      .send({
        items: [
          { parameterKey: "pression_air_comprime", value: "5", status: "CONFORME" },
          { parameterKey: "temperature_machine", value: "185", status: "CONFORME" },
          { parameterKey: "etat_disque_coupe", value: "OK", status: "CONFORME" },
          { parameterKey: "fuite_air_comprime", value: "20 x 20", status: "CONFORME", remark: "RAS" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("EN_COURS");
    expect(await itemValue(control1, "pression_air_comprime")).toEqual({ value: "5", status: "CONFORME" });
  });

  test("TEST 10 — le contrôle apparaît dans l'historique (filtres ligne / machine / « À vérifier »)", async () => {
    const res = await request(app).get("/quality-control?productionType=PROMESH&machine=1&status=EN_ATTENTE,EN_COURS").set(auth(qc.token));
    expect(res.status).toBe(200);
    expect(res.body.data.some((c) => c.id === control1)).toBe(true);
  });

  test("TEST 11/12 — réouverture : toutes les valeurs préremplies depuis la base", async () => {
    const res = await request(app).get(`/quality-control/${control1}`).set(auth(qc.token));
    const byKey = Object.fromEntries(res.body.data.items.map((i) => [i.parameterKey, i]));
    expect(byKey.pression_air_comprime).toMatchObject({ value: "5", status: "CONFORME" });
    expect(byKey.temperature_machine.value).toBe("185");
    expect(byKey.etat_disque_coupe.value).toBe("OK");
    expect(byKey.fuite_air_comprime).toMatchObject({ value: "20 x 20", remark: "RAS" });
  });

  test("TEST 13/14/15 — modification 5 → 6 : persistée, relue, tracée", async () => {
    const res = await request(app).put(`/quality-control/${control1}`).set(auth(qc.token)).send({ items: [{ parameterKey: "pression_air_comprime", value: "6" }] });
    expect(res.status).toBe(200);
    expect(await itemValue(control1, "pression_air_comprime")).toEqual({ value: "6", status: "CONFORME" });
    const reopened = await request(app).get(`/quality-control/${control1}`).set(auth(qc.token));
    expect(reopened.body.data.items.find((i) => i.parameterKey === "pression_air_comprime").value).toBe("6");
    expect(reopened.body.data.history.some((h) => h.parameterKey === "pression_air_comprime" && h.oldValue === "5" && h.newValue === "6")).toBe(true);
    // Les autres valeurs n'ont pas été remises à zéro.
    expect((await itemValue(control1, "temperature_machine")).value).toBe("185");
  });

  test("validation → CONFORME, puis historique filtrable sur Conforme", async () => {
    const res = await request(app).post(`/quality-control/${control1}/validate`).set(auth(qc.token)).send({ status: "CONFORME" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CONFORME");
    const list = await request(app).get("/quality-control?status=CONFORME&machine=1").set(auth(qc.token));
    expect(list.body.data.some((c) => c.id === control1)).toBe(true);
  });

  test.each(["2", "3", "4"])("TESTS 16-18 — PROMESH Machine %s : contrôle créé sur la bonne machine", async (m) => {
    const res = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: m });
    expect(res.status).toBe(201);
    createdControls.push(res.body.data.id);
    expect(res.body.data).toMatchObject({ productionType: "PROMESH", machine: m });
    const list = await request(app).get(`/quality-control?productionType=PROMESH&machine=${m}`).set(auth(qc.token));
    expect(list.body.data.every((c) => c.machine === m)).toBe(true);
  });

  test("TESTS 21/22 — contrôle PROBAR, jamais mélangé avec PROMESH", async () => {
    const res = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROBAR", machine: "1" });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    createdControls.push(id);
    expect(res.body.data.productionType).toBe("PROBAR");

    const probar = await request(app).get("/quality-control?productionType=PROBAR").set(auth(qc.token));
    const promesh = await request(app).get("/quality-control?productionType=PROMESH").set(auth(qc.token));
    expect(probar.body.data.every((c) => c.productionType === "PROBAR")).toBe(true);
    expect(probar.body.data.some((c) => c.id === id)).toBe(true);
    expect(promesh.body.data.some((c) => c.id === id)).toBe(false);
  });

  test("§21 — saisie réservée à controle_qualite : l'admin consulte (200) mais ne crée/modifie pas (403)", async () => {
    expect((await request(app).get(`/quality-control/${control1}`).set(auth(adminToken))).status).toBe(200);
    expect((await request(app).get("/quality-control/config").set(auth(adminToken))).status).toBe(200);
    expect((await request(app).post("/quality-control").set(auth(adminToken)).send({ productionType: "PROMESH", machine: "1" })).status).toBe(403);
    expect((await request(app).put(`/quality-control/${control1}`).set(auth(adminToken)).send({ remark: "x" })).status).toBe(403);
  });

  test("§22 — audit : contrôleur, date/heure, création et modifications conservés", async () => {
    const res = await request(app).get(`/quality-control/${control1}`).set(auth(qc.token));
    const c = res.body.data;
    expect(c).toMatchObject({ controllerEmail: QC_EMAIL, controllerUserId: qc.user.id, isValidated: true });
    expect(c.controlDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(c.controlTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(new Date(c.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(c.createdAt).getTime());
    expect(c.history.map((h) => h.action)).toEqual(expect.arrayContaining(["CREATE", "UPDATE", "VALIDATE"]));
  });

  test("tableau de bord — GET /quality-control/stats : agrégats réels par ligne / machine (aucune machine inventée)", async () => {
    const res = await request(app).get("/quality-control/stats?period=all").set(auth(qc.token));
    expect(res.status).toBe(200);
    const s = res.body.data;
    expect(s.lines.map((l) => l.type)).toEqual(["PROMESH", "PROBAR"]);
    for (const l of s.lines) expect(l.machines.map((m) => m.machine)).toEqual(["1", "2", "3", "4"]);
    // Même portée que la liste (controle_qualite : ses propres contrôles).
    const list = await request(app).get("/quality-control?limit=1").set(auth(qc.token));
    expect(s.totals.total).toBe(list.body.pagination.total);
    expect(s.totals.total).toBe(s.totals.conforme + s.totals.nonConforme + s.totals.aVerifier);
    const promeshList = await request(app).get("/quality-control?limit=1&productionType=PROMESH").set(auth(qc.token));
    expect(s.lines[0].total).toBe(promeshList.body.pagination.total);
    const m1 = s.lines[0].machines[0];
    const m1List = await request(app).get("/quality-control?limit=1&productionType=PROMESH&machine=1").set(auth(qc.token));
    expect(m1.total).toBe(m1List.body.pagination.total);
    if (m1.total > 0) {
      expect(m1.lastControl.id).toBe(m1List.body.data[0].id);
      expect(m1.lastControl.controlDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    }
    expect(s.totals.machines).toBe(8);
    expect(s.totals.machinesActives).toBeLessThanOrEqual(8);
  });

  // NB : une semaine (lundi → aujourd'hui) peut chevaucher deux mois ou deux
  // années — seules les inclusions toujours vraies sont vérifiées.
  test("tableau de bord — périodes (aujourd'hui ⊂ semaine, aujourd'hui ⊂ mois ⊂ année ⊂ tout), période invalide refusée", async () => {
    const t = {};
    for (const period of ["today", "week", "month", "year", "all"]) {
      const r = await request(app).get(`/quality-control/stats?period=${period}`).set(auth(qc.token));
      expect(r.status).toBe(200);
      t[period] = r.body.data.totals.total;
    }
    expect(t.week).toBeGreaterThanOrEqual(t.today);
    expect(t.month).toBeGreaterThanOrEqual(t.today);
    expect(t.year).toBeGreaterThanOrEqual(t.month);
    expect(t.all).toBeGreaterThanOrEqual(t.year);
    expect(t.all).toBeGreaterThanOrEqual(t.week);
    // Les contrôles créés par ce test datent d'aujourd'hui.
    expect(t.today).toBeGreaterThanOrEqual(createdControls.length);
    expect((await request(app).get("/quality-control/stats?period=decade").set(auth(qc.token))).status).toBe(400);
    expect((await request(app).get("/quality-control/stats").set(auth(adminToken))).status).toBe(200);
  });

  test("recherche globale : référence, ligne ou « machine N »", async () => {
    const r = await request(app).get("/quality-control?search=machine 1&limit=50").set(auth(qc.token));
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    for (const c of r.body.data) {
      const hay = `${c.ficheNumero} ${c.productionType} ${c.controllerEmail}`.toLowerCase();
      expect(c.machine === "1" || hay.includes("machine 1")).toBe(true);
    }
    const ref = await request(app).get("/quality-control?search=PROBAR&limit=50").set(auth(qc.token));
    expect(ref.body.data.every((c) => c.productionType === "PROBAR" || String(c.ficheNumero).toUpperCase().includes("PROBAR"))).toBe(true);
  });

  // ── En-tête modifiable : date / heure d'ouverture, date de production, poste ──

  async function headerRow(id) {
    const [r] = await sequelize.query(
      `SELECT "controlDate"::text AS "controlDate", "controlTime"::text AS "controlTime", "productionDate"::text AS "productionDate", poste
         FROM quality_controls WHERE id = :id`,
      { replacements: { id }, type: QueryTypes.SELECT }
    );
    return r;
  }

  test("en-tête — scénario complet : création, brouillon, réouverture, modification, relecture PostgreSQL", async () => {
    // 1. Nouveau contrôle PROMESH : ouverture proposée = maintenant (Tunis).
    const created = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "1" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    createdControls.push(id);
    expect(created.body.data.controlDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(created.body.data.controlTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect([null, "matin"]).toContain(created.body.data.poste); // jamais "nuit" (hors liste)
    const db0 = await headerRow(id);
    expect(db0.controlDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 2-3. Modification + brouillon (PUT).
    const draft = await request(app).put(`/quality-control/${id}`).set(auth(qc.token)).send({
      controlDate: "2026-09-30",
      controlTime: "08:15:00",
      productionDate: "2026-09-29",
      poste: "soir",
    });
    expect(draft.status).toBe(200);
    expect(draft.body.data.isValidated).toBe(false);

    // 4-6. Réouverture : valeurs exactes (API + PostgreSQL).
    const reopened = (await request(app).get(`/quality-control/${id}`).set(auth(qc.token))).body.data;
    expect(reopened).toMatchObject({ controlDate: "30/09/2026", controlTime: "08:15:00", productionDate: "2026-09-29", poste: "soir", posteLabel: "Soir" });
    expect(await headerRow(id)).toEqual({ controlDate: "2026-09-30", controlTime: "08:15:00", productionDate: "2026-09-29", poste: "soir" });

    // 7-8. Poste = Matin, date de production = 30/09/2026 (envoi partiel).
    const upd = await request(app).put(`/quality-control/${id}`).set(auth(qc.token)).send({ poste: "matin", productionDate: "2026-09-30" });
    expect(upd.status).toBe(200);

    // 9-10. Relecture : nouvelles valeurs conservées, les autres intactes.
    expect(await headerRow(id)).toEqual({ controlDate: "2026-09-30", controlTime: "08:15:00", productionDate: "2026-09-30", poste: "matin" });
    const again = (await request(app).get(`/quality-control/${id}`).set(auth(qc.token))).body.data;
    expect(again).toMatchObject({ controlDate: "30/09/2026", controlTime: "08:15:00", productionDate: "2026-09-30", poste: "matin" });

    // Audit : chaque champ modifié tracé (ancienne → nouvelle valeur).
    const fields = again.history.filter((h) => h.action === "UPDATE" && !h.parameterKey).map((h) => `${h.field}:${h.oldValue}→${h.newValue}`);
    expect(fields).toEqual(expect.arrayContaining(["controlTime:" + db0.controlTime.slice(0, 8) + "→08:15:00", "poste:soir→matin", "productionDate:2026-09-29→2026-09-30"]));

    // La validation horodate (validatedAt) SANS écraser l'ouverture choisie.
    const val = await request(app)
      .post(`/quality-control/${id}/validate`)
      .set(auth(qc.token))
      .send({ status: "CONFORME", items: [{ parameterKey: "temperature_eau", value: "8", status: "CONFORME" }] });
    expect(val.status).toBe(200);
    expect(val.body.data).toMatchObject({ isValidated: true, controlDate: "30/09/2026", controlTime: "08:15:00", productionDate: "2026-09-30", poste: "matin" });
    expect(val.body.data.validatedDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);

    // Contrôle validé : lecture seule (l'en-tête ne peut plus changer).
    const locked = await request(app).put(`/quality-control/${id}`).set(auth(qc.token)).send({ poste: "soir", changeReason: "x" });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("CONTROL_LOCKED");
    expect((await headerRow(id)).poste).toBe("matin");
  });

  test("en-tête — validation backend : dates/heure invalides et poste hors liste refusés, rien n'est écrit", async () => {
    const created = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "2" });
    const id = created.body.data.id;
    createdControls.push(id);
    const before = await headerRow(id);
    for (const body of [
      { controlDate: "2026-02-30" },
      { controlDate: "30/09/2026" },
      { controlDate: "" },
      { controlTime: "25:00:00" },
      { controlTime: "08:15" },
      { productionDate: "2026-13-01" },
      { productionDate: null },
      { poste: "nuit" },
      { poste: "Soirée" },
      { poste: "" },
    ]) {
      const r = await request(app).put(`/quality-control/${id}`).set(auth(qc.token)).send(body);
      expect({ body, status: r.status, code: r.body.code }).toEqual({ body, status: 400, code: "INVALID_PAYLOAD" });
    }
    expect(await headerRow(id)).toEqual(before);
    // L'admin (lecture seule) ne peut pas modifier l'en-tête.
    expect((await request(app).put(`/quality-control/${id}`).set(auth(adminToken)).send({ poste: "soir" })).status).toBe(403);
  });

  test("en-tête — un envoi sans ces champs ne modifie aucune valeur existante", async () => {
    const created = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "1" });
    const id = created.body.data.id;
    createdControls.push(id);
    await request(app).put(`/quality-control/${id}`).set(auth(qc.token)).send({ controlDate: "2026-09-28", controlTime: "06:00:00", productionDate: "2026-09-27", poste: "soir" });
    const before = await headerRow(id);
    const r = await request(app).put(`/quality-control/${id}`).set(auth(qc.token)).send({ remark: "RAS", items: [{ parameterKey: "fuite_eau", value: "Absent", status: "CONFORME" }] });
    expect(r.status).toBe(200);
    expect(await headerRow(id)).toEqual(before);
  });

  // ── Synchronisation : une seule source de vérité (PostgreSQL) ───────────

  test("indépendance de la production : un productionRecordId envoyé n'est JAMAIS enregistré (création ni modification)", async () => {
    const fiche = await PorPromesh.findOne({ where: { machine: "1" }, attributes: ["id"] });
    const created = await request(app)
      .post("/quality-control")
      .set(auth(qc.token))
      .send({ productionType: "PROMESH", machine: "1", productionRecordId: `promesh:${fiche.id}` });
    expect(created.status).toBe(201);
    createdControls.push(created.body.data.id);
    expect(created.body.data).toMatchObject({ productionRecordId: null, productionRecordRef: null, ficheNumero: null });
    const upd = await request(app).put(`/quality-control/${created.body.data.id}`).set(auth(qc.token)).send({ productionRecordId: `promesh:${fiche.id}`, poste: "matin" });
    expect(upd.status).toBe(200);
    const [row] = await sequelize.query(`SELECT "productionRecordId", "ficheNumero", poste FROM quality_controls WHERE id = :id`, {
      replacements: { id: created.body.data.id },
      type: QueryTypes.SELECT,
    });
    expect(row).toEqual({ productionRecordId: null, ficheNumero: null, poste: "matin" });
    // Plusieurs fiches qualité pour la même machine : jamais bloqué par une production.
    const second = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "1" });
    expect(second.status).toBe(201);
    createdControls.push(second.body.data.id);
    // Deux créations SIMULTANÉES : deux fiches, références distinctes.
    const both = await Promise.all([1, 2].map(() => request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "2" })));
    for (const r of both) createdControls.push(r.body.data.id);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(new Set(both.map((r) => r.body.data.reference)).size).toBe(2);
  });

  test("sync — mêmes chiffres à tous les niveaux (stats = liste) pour chaque période, ligne et machine", async () => {
    for (const period of ["today", "week", "month", "year", "all"]) {
      const s = (await request(app).get(`/quality-control/stats?period=${period}`).set(auth(qc.token))).body.data;
      const total = async (q) => (await request(app).get(`/quality-control?limit=1&period=${period}${q}`).set(auth(qc.token))).body.pagination.total;
      expect({ period, total: s.totals.total }).toEqual({ period, total: await total("") });
      expect(s.totals.total).toBe(s.totals.conforme + s.totals.nonConforme + s.totals.aVerifier);
      expect(s.totals.conforme).toBe(await total("&status=CONFORME"));
      expect(s.totals.nonConforme).toBe(await total("&status=NON_CONFORME"));
      expect(s.totals.aVerifier).toBe(await total("&status=EN_ATTENTE,EN_COURS"));
      for (const line of s.lines) {
        expect({ period, line: line.type, n: line.total }).toEqual({ period, line: line.type, n: await total(`&productionType=${line.type}`) });
        for (const m of line.machines) {
          expect({ period, line: line.type, m: m.machine, n: m.total }).toEqual({
            period,
            line: line.type,
            m: m.machine,
            n: await total(`&productionType=${line.type}&machine=${m.machine}`),
          });
        }
      }
    }
    // Dernier contrôle d'une machine = 1re ligne de « Contrôles de cette machine ».
    const all = (await request(app).get("/quality-control/stats?period=all").set(auth(qc.token))).body.data;
    for (const m of all.lines[0].machines.filter((x) => x.lastControl)) {
      const list = (await request(app).get(`/quality-control?limit=1&productionType=PROMESH&machine=${m.machine}`).set(auth(qc.token))).body.data;
      expect(list[0]).toMatchObject({ id: m.lastControl.id, status: m.lastControl.status, controlDate: m.lastControl.controlDate });
    }
  });

  test("sync — la période suit la date DU CONTRÔLE (ouverture), pas la date de saisie", async () => {
    const created = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "2" });
    const id = created.body.data.id;
    createdControls.push(id);
    const inPeriod = async (period) =>
      (await request(app).get(`/quality-control?limit=100&period=${period}&productionType=PROMESH&machine=2`).set(auth(qc.token))).body.data.some((c) => c.id === id);
    expect(await inPeriod("today")).toBe(true); // ouvert maintenant
    // Ouvert le 15/06/2025 (saisi aujourd'hui) : hors « aujourd'hui » et « cette année ».
    await request(app).put(`/quality-control/${id}`).set(auth(qc.token)).send({ controlDate: "2025-06-15", controlTime: "09:00:00" });
    expect(await inPeriod("today")).toBe(false);
    expect(await inPeriod("year")).toBe(false);
    expect(await inPeriod("all")).toBe(true);
    const yearStats = (await request(app).get("/quality-control/stats?period=year").set(auth(qc.token))).body.data;
    const yearList = (await request(app).get("/quality-control?limit=1&period=year").set(auth(qc.token))).body.pagination.total;
    expect(yearStats.totals.total).toBe(yearList);
    const bounded = await request(app).get(`/quality-control?limit=100&from=2025-06-15&to=2025-06-15`).set(auth(qc.token));
    expect(bounded.body.data.map((c) => c.id)).toContain(id);
    expect((await request(app).get("/quality-control?period=decade").set(auth(qc.token))).status).toBe(400);
  });

  test("sync — brouillon → validé NON CONFORME : statistiques recalculées depuis la base, puis lecture seule", async () => {
    const created = await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "1" });
    const id = created.body.data.id;
    createdControls.push(id);
    const stats = async () => (await request(app).get("/quality-control/stats?period=all").set(auth(qc.token))).body.data.lines[0];
    const s0 = await stats();
    // Nouveau contrôle non validé = À VÉRIFIER (jamais Conforme / Non conforme).
    expect(created.body.data.status).toBe("EN_ATTENTE");
    expect(s0.aVerifier).toBeGreaterThanOrEqual(1);
    await request(app)
      .post(`/quality-control/${id}/validate`)
      .set(auth(qc.token))
      .send({ items: [{ parameterKey: "temperature_eau", value: "9", status: "NON_CONFORME", remark: "hors tolérance" }] });
    const s1 = await stats();
    expect({ t: s1.total, c: s1.conforme, nc: s1.nonConforme, av: s1.aVerifier }).toEqual({ t: s0.total, c: s0.conforme, nc: s0.nonConforme + 1, av: s0.aVerifier - 1 });
    // Validé = lecture seule : toute tentative de changement est refusée,
    // les statistiques ne bougent pas.
    const locked = await request(app)
      .put(`/quality-control/${id}`)
      .set(auth(qc.token))
      .send({ status: "CONFORME", changeReason: "remesure conforme", items: [{ parameterKey: "temperature_eau", value: "8", status: "CONFORME" }] });
    expect(locked.status).toBe(403);
    const s2 = await stats();
    expect({ t: s2.total, c: s2.conforme, nc: s2.nonConforme, av: s2.aVerifier }).toEqual({ t: s1.total, c: s1.conforme, nc: s1.nonConforme, av: s1.aVerifier });
    // Résultat en base = résultat affiché (jamais le statut de la fiche de production).
    const [row] = await sequelize.query(`SELECT status, "validatedAt" FROM quality_controls WHERE id = :id`, { replacements: { id }, type: QueryTypes.SELECT });
    expect(row.status).toBe("NON_CONFORME");
    expect(row.validatedAt).not.toBeNull();
  });

  // ── Workflow « Valider le contrôle » : Conforme ET Non conforme enregistrés ──

  async function dbControl(id) {
    const [c] = await sequelize.query(
      `SELECT status, "validatedAt", "controllerEmail", "controlDate"::text AS "controlDate", "controlTime"::text AS "controlTime",
              "productionDate"::text AS "productionDate", poste, remark FROM quality_controls WHERE id = :id`,
      { replacements: { id }, type: QueryTypes.SELECT }
    );
    const items = await sequelize.query(`SELECT "parameterKey", value, status, remark FROM quality_control_items WHERE "qualityControlId" = :id`, {
      replacements: { id },
      type: QueryTypes.SELECT,
    });
    return { ...c, items: Object.fromEntries(items.map((i) => [i.parameterKey, i])) };
  }
  const promeshStats = async () => (await request(app).get("/quality-control/stats?period=all").set(auth(qc.token))).body.data.lines[0];

  test("TEST 1 — nouveau contrôle CONFORME : création + saisie + validation en UNE requête, enregistré en base", async () => {
    const before = await promeshStats();
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qc.token))
      .send({
        productionType: "PROMESH", machine: "1",
        validate: true,
        status: "CONFORME",
        controlDate: "2026-10-01",
        controlTime: "10:35:00",
        productionDate: "2026-09-30",
        poste: "matin",
        remark: "RAS",
        items: [
          { parameterKey: "temperature_eau", value: "8", status: "CONFORME" },
          { parameterKey: "temperature_machine", value: "180", status: "CONFORME" },
          { parameterKey: "niveau_bain_graines", value: "Bien", status: "CONFORME" },
        ],
      });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    createdControls.push(id);
    expect(res.body.data).toMatchObject({ status: "CONFORME", isValidated: true, controlDate: "01/10/2026", controlTime: "10:35:00" });
    const db = await dbControl(id);
    expect(db).toMatchObject({ status: "CONFORME", controllerEmail: QC_EMAIL, controlDate: "2026-10-01", controlTime: "10:35:00", productionDate: "2026-09-30", poste: "matin", remark: "RAS" });
    expect(db.validatedAt).not.toBeNull();
    expect(db.items.temperature_eau).toMatchObject({ value: "8", status: "CONFORME" });
    expect(db.items.niveau_bain_graines).toMatchObject({ value: "Bien", status: "CONFORME" });
    // Historique (liste) + journal.
    const list = await request(app).get("/quality-control?limit=100&status=CONFORME").set(auth(qc.token));
    expect(list.body.data.some((c) => c.id === id)).toBe(true);
    expect(res.body.data.history.map((h) => h.action)).toEqual(expect.arrayContaining(["CREATE", "VALIDATE"]));
    // Statistiques recalculées depuis la base.
    const after = await promeshStats();
    expect({ t: after.total, c: after.conforme }).toEqual({ t: before.total + 1, c: before.conforme + 1 });
  });

  test("TEST 2 — NON CONFORME enregistré SANS blocage (aucune remarque exigée), brouillon → validation", async () => {
    const before = await promeshStats();
    // Brouillon (À vérifier) créé avec sa saisie.
    const draft = await request(app)
      .post("/quality-control")
      .set(auth(qc.token))
      .send({ productionType: "PROMESH", machine: "1", items: [{ parameterKey: "temperature_eau", value: "9.4", status: "NON_CONFORME" }] });
    expect(draft.status).toBe(201);
    const id = draft.body.data.id;
    createdControls.push(id);
    expect(draft.body.data.status).toBe("EN_COURS"); // À vérifier
    expect((await promeshStats()).aVerifier).toBe(before.aVerifier + 1);
    // Valider NON CONFORME, sans aucune remarque.
    const res = await request(app)
      .post(`/quality-control/${id}/validate`)
      .set(auth(qc.token))
      .send({ status: "NON_CONFORME", items: [{ parameterKey: "pression_air_comprime", value: "4", status: "NON_CONFORME" }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "NON_CONFORME", isValidated: true });
    const db = await dbControl(id);
    expect(db.status).toBe("NON_CONFORME");
    expect(db.validatedAt).not.toBeNull();
    expect(db.items.temperature_eau).toMatchObject({ value: "9.4", status: "NON_CONFORME" });
    expect(db.items.pression_air_comprime).toMatchObject({ value: "4", status: "NON_CONFORME" });
    const after = await promeshStats();
    expect({ t: after.total, nc: after.nonConforme, av: after.aVerifier }).toEqual({ t: before.total + 1, nc: before.nonConforme + 1, av: before.aVerifier });
    // Résultat NON CONFORME choisi sans paramètre non conforme : enregistré aussi.
    const global = await request(app)
      .post("/quality-control")
      .set(auth(qc.token))
      .send({ productionType: "PROMESH", machine: "2", validate: true, status: "NON_CONFORME", items: [{ parameterKey: "temperature_eau", value: "8", status: "CONFORME" }] });
    expect(global.status).toBe(201);
    createdControls.push(global.body.data.id);
    expect((await dbControl(global.body.data.id)).status).toBe("NON_CONFORME");
  });

  test("TEST 3/4/5 — édition d'un BROUILLON existant (PUT, même id) : paramètre, en-tête et résultat, puis validation", async () => {
    const created = await request(app)
      .post("/quality-control")
      .set(auth(qc.token))
      .send({ productionType: "PROMESH", machine: "1", items: [{ parameterKey: "temperature_eau", value: "9.4", status: "NON_CONFORME" }] });
    const id = created.body.data.id;
    createdControls.push(id);
    // La fiche est retrouvée sur SA machine, par son id PostgreSQL.
    const machine1 = (await request(app).get("/quality-control?limit=100&productionType=PROMESH&machine=1").set(auth(qc.token))).body.data;
    expect(machine1.map((c) => c.id)).toContain(id);
    const before = await promeshStats();
    const upd = await request(app)
      .put(`/quality-control/${id}`)
      .set(auth(qc.token))
      .send({
        controlDate: "2026-10-01",
        controlTime: "11:00:00",
        productionDate: "2026-09-29",
        poste: "soir",
        items: [{ parameterKey: "temperature_eau", value: "8", status: "CONFORME" }],
      });
    expect(upd.status).toBe(200);
    expect(upd.body.data.id).toBe(id); // UPDATE, jamais un nouveau contrôle
    expect(upd.body.data.isValidated).toBe(false); // toujours brouillon
    const val = await request(app).post(`/quality-control/${id}/validate`).set(auth(qc.token)).send({ status: "CONFORME" });
    expect(val.status).toBe(200);
    // Rechargement complet depuis la base.
    const db = await dbControl(id);
    expect(db.validatedAt).not.toBeNull();
    expect(db).toMatchObject({ status: "CONFORME", controlDate: "2026-10-01", controlTime: "11:00:00", productionDate: "2026-09-29", poste: "soir" });
    expect(db.items.temperature_eau).toMatchObject({ value: "8", status: "CONFORME" });
    const reopened = (await request(app).get(`/quality-control/${id}`).set(auth(qc.token))).body.data;
    expect(reopened.items.find((i) => i.parameterKey === "temperature_eau")).toMatchObject({ value: "8", status: "CONFORME" });
    const after = await promeshStats();
    // Brouillon (À vérifier) → validé CONFORME.
    expect({ c: after.conforme, av: after.aVerifier, t: after.total }).toEqual({ c: before.conforme + 1, av: before.aVerifier - 1, t: before.total });
    // Puis lecture seule : ni modification ni suppression.
    expect((await request(app).put(`/quality-control/${id}`).set(auth(qc.token)).send({ poste: "matin" })).status).toBe(403);
    expect((await request(app).delete(`/quality-control/${id}`).set(auth(qc.token))).status).toBe(403);
    // Machine : dernier contrôle = celui-ci, statut CONFORME.
    const machine = (await request(app).get(`/quality-control?limit=100&productionType=PROMESH&machine=1`).set(auth(qc.token))).body.data;
    expect(machine.find((c) => c.id === id).status).toBe("CONFORME");
  });

  test("création + validation atomiques : données obligatoires manquantes → 422 et AUCUNE fiche créée", async () => {
    const count = async () =>
      (
        await sequelize.query(`SELECT count(*)::int AS n FROM quality_controls WHERE "productionType" = 'PROMESH' AND machine = '2'`, {
          type: QueryTypes.SELECT,
        })
      )[0].n;
    const before = await count();
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qc.token))
      .send({ productionType: "PROMESH", machine: "2", validate: true, status: "CONFORME", items: [] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(await count()).toBe(before);
  });

  // ── Statut BROUILLON / VALIDÉ, suppression, machines, contrôleur ─────────

  test("TEST A/B/C/D — brouillon modifiable et supprimable ; validé NON CONFORME = enregistré puis lecture seule", async () => {
    // A — brouillon : modifiable.
    const draft = (await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "2" })).body.data;
    createdControls.push(draft.id);
    expect(draft.isValidated).toBe(false);
    const edit = await request(app).put(`/quality-control/${draft.id}`).set(auth(qc.token)).send({ poste: "soir", items: [{ parameterKey: "temperature_eau", value: "9.6", status: "NON_CONFORME" }] });
    expect(edit.status).toBe(200);
    // B/C — validation NON CONFORME : statut VALIDÉ + résultat NON CONFORME.
    const val = await request(app).post(`/quality-control/${draft.id}/validate`).set(auth(qc.token)).send({ status: "NON_CONFORME" });
    expect(val.status).toBe(200);
    expect(val.body.data).toMatchObject({ isValidated: true, status: "NON_CONFORME", controllerEmail: QC_EMAIL });
    expect(val.body.data.validatedDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    const locked = await request(app).put(`/quality-control/${draft.id}`).set(auth(qc.token)).send({ remark: "après coup" });
    expect(locked.status).toBe(403);
    expect(locked.body.message).toBe("Un contrôle validé est en lecture seule et ne peut plus être modifié.");
    const noDel = await request(app).delete(`/quality-control/${draft.id}`).set(auth(qc.token));
    expect(noDel.status).toBe(403);
    expect(noDel.body.message).toBe("Un contrôle validé ne peut pas être supprimé.");
    expect((await request(app).delete(`/quality-control/${draft.id}`).set(auth(adminToken))).status).toBe(403);

    // D — suppression d'un brouillon : contrôle supprimé, fiche intacte, statistiques à jour.
    const d2 = (await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "2" })).body.data;
    createdControls.push(d2.id);
    const before = await promeshStats();
    const del = await request(app).delete(`/quality-control/${d2.id}`).set(auth(qc.token));
    expect(del.status).toBe(200);
    const after = await promeshStats();
    expect({ t: after.total, av: after.aVerifier }).toEqual({ t: before.total - 1, av: before.aVerifier - 1 });
    expect((await request(app).get(`/quality-control/${d2.id}`).set(auth(qc.token))).status).toBe(404);
  });

  test("TEST E — machines : chaque page machine ne reçoit que SES fiches et SES contrôles (filtre SQL backend)", async () => {
    for (const [type, machines] of [["promesh", ["1", "2", "3", "4"]], ["probar", ["1", "2", "3", "4"]]]) {
      for (const m of machines) {
        const fiches = await request(app).get(`/production-records?type=${type}&machineId=${m}&limit=100`).set(auth(qc.token));
        expect(fiches.status).toBe(200);
        expect(fiches.body.data.every((f) => f.type === type && String(f.machine) === m)).toBe(true);
        const [{ n }] = await sequelize.query(
          type === "promesh"
            ? `SELECT count(*)::int AS n FROM por_promesh WHERE machine = :m`
            : `SELECT count(*)::int AS n FROM industrial_records WHERE module = 'probar' AND machine = :m`,
          { replacements: { m }, type: QueryTypes.SELECT }
        );
        expect({ type, m, total: fiches.body.pagination.total }).toEqual({ type, m, total: n });
        const controls = await request(app).get(`/quality-control?limit=100&productionType=${type.toUpperCase()}&machine=${m}`).set(auth(qc.token));
        expect(controls.body.data.every((c) => c.productionType === type.toUpperCase() && c.machine === m)).toBe(true);
      }
    }
    // Statistiques et dernier contrôle par (ligne, machine) uniquement.
    const s = (await request(app).get("/quality-control/stats?period=all").set(auth(qc.token))).body.data;
    for (const line of s.lines) {
      for (const m of line.machines.filter((x) => x.lastControl)) {
        const c = (await request(app).get(`/quality-control/${m.lastControl.id}`).set(auth(qc.token))).body.data;
        expect({ type: c.productionType, machine: c.machine }).toEqual({ type: line.type, machine: m.machine });
      }
    }
  });

  test("TEST F — contrôleur : uniquement des comptes controle_qualite, jamais un compte de production", async () => {
    const list = (await request(app).get("/quality-control?limit=100").set(auth(qc.token))).body.data;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.controllerEmail === QC_EMAIL)).toBe(true);
    // Aucun compte de production / logistique / admin comme contrôleur.
    const [{ n }] = await sequelize.query(
      `SELECT count(*)::int AS n FROM quality_controls
        WHERE "controllerEmail" ILIKE 'production%' OR "controllerEmail" ILIKE 'responsable%' OR "controllerEmail" ILIKE 'cbitunisia%'`,
      { type: QueryTypes.SELECT }
    );
    expect(n).toBe(0);
    const [{ others }] = await sequelize.query(
      `SELECT count(*)::int AS others FROM quality_controls q JOIN users u ON u.id = q."controllerUserId" WHERE u.role <> 'controle_qualite'`,
      { type: QueryTypes.SELECT }
    );
    expect(others).toBe(0);
  });

  // ── Fiches qualité par MACHINE (production optionnelle) ─────────────────

  const machineList = async (type, m) =>
    (await request(app).get(`/quality-control?limit=100&productionType=${type}&machine=${m}`).set(auth(qc.token))).body.data;

  test("MACHINE TEST 1/2/3 — nouvelle fiche Machine 1 SANS production : brouillon, référence, auteur JWT ; visible sur Machine 1 seulement", async () => {
    const res = await request(app)
      .post("/quality-control")
      .set(auth(qc.token))
      .send({ productionType: "PROMESH", machine: "1", controllerEmail: "production_1@cbi-tunisia.com", createdBy: "pirate" });
    expect(res.status).toBe(201);
    const c = res.body.data;
    createdControls.push(c.id);
    expect(c).toMatchObject({
      productionType: "PROMESH",
      machine: "1",
      machineLabel: "Machine 1",
      productionRecordId: null,
      productionRecordRef: null,
      ficheNumero: null,
      controllerEmail: QC_EMAIL,
      controllerUserId: qc.user.id,
      isValidated: false,
      status: "EN_ATTENTE",
    });
    expect(c.reference).toMatch(/^QC-(PROMESH|PROBAR)-\d{6}$/);
    // TEST 2 — brouillon rempli puis enregistré : présent sur Machine 1.
    const draft = await request(app)
      .put(`/quality-control/${c.id}`)
      .set(auth(qc.token))
      .send({ poste: "soir", productionDate: "2026-09-30", items: [{ parameterKey: "temperature_eau", value: "8", status: "CONFORME" }] });
    expect(draft.status).toBe(200);
    expect(draft.body.data.isValidated).toBe(false);
    expect((await machineList("PROMESH", "1")).map((x) => x.id)).toContain(c.id);
    for (const [t, m] of [["PROMESH", "2"], ["PROMESH", "3"], ["PROMESH", "4"], ["PROBAR", "1"]]) {
      expect((await machineList(t, m)).map((x) => x.id)).not.toContain(c.id);
    }
    // TEST 3 — réouverture : préremplie, modifiable.
    const reopened = (await request(app).get(`/quality-control/${c.id}`).set(auth(qc.token))).body.data;
    expect(reopened).toMatchObject({ reference: c.reference, poste: "soir", productionDate: "2026-09-30" });
    expect(reopened.items.find((i) => i.parameterKey === "temperature_eau")).toMatchObject({ value: "8", status: "CONFORME" });
      // Aucune production ne peut être associée (champ ignoré).
    const ignored = await request(app).put(`/quality-control/${c.id}`).set(auth(qc.token)).send({ productionRecordId: "promesh:00000000-0000-0000-0000-000000000001" });
    expect(ignored.status).toBe(200);
    expect(ignored.body.data).toMatchObject({ productionRecordRef: null, ficheNumero: null });
    // Suppression du brouillon.
    expect((await request(app).delete(`/quality-control/${c.id}`).set(auth(qc.token))).status).toBe(200);
    expect((await machineList("PROMESH", "1")).map((x) => x.id)).not.toContain(c.id);
  });

  test("MACHINE TEST 4/5 — fiches machine validées CONFORME et NON CONFORME : VALIDÉ, résultat enregistré, lecture seule", async () => {
    for (const result of ["CONFORME", "NON_CONFORME"]) {
      const res = await request(app)
        .post("/quality-control")
        .set(auth(qc.token))
        .send({
          productionType: "PROBAR",
          machine: "3",
          validate: true,
          status: result,
          items: [{ parameterKey: "nombre_bobines", value: "10", status: "CONFORME" }],
        });
      expect(res.status).toBe(201);
      createdControls.push(res.body.data.id);
      expect(res.body.data).toMatchObject({ productionType: "PROBAR", machine: "3", isValidated: true, status: result, productionRecordRef: null });
      expect((await request(app).put(`/quality-control/${res.body.data.id}`).set(auth(qc.token)).send({ remark: "x" })).status).toBe(403);
      expect((await request(app).delete(`/quality-control/${res.body.data.id}`).set(auth(qc.token))).status).toBe(403);
    }
    // Statistiques PROBAR Machine 3 = exactement ses fiches (calcul SQL).
    const s = (await request(app).get("/quality-control/stats?period=all").set(auth(qc.token))).body.data;
    const m3 = s.lines.find((l) => l.type === "PROBAR").machines.find((m) => m.machine === "3");
    const list = await machineList("PROBAR", "3");
    expect(m3.total).toBe(list.length);
    expect(m3.conforme).toBe(list.filter((c) => c.isValidated && c.status === "CONFORME").length);
    expect(m3.nonConforme).toBe(list.filter((c) => c.isValidated && c.status === "NON_CONFORME").length);
    expect(m3.aVerifier).toBe(list.filter((c) => !c.isValidated).length);
    expect(m3.lastControl.id).toBe(list[0].id);
    expect(m3.lastControl.reference).toBe(list[0].reference);
  });

  test("MACHINE — ligne / machine inconnues refusées ; références uniques et séquentielles", async () => {
    for (const body of [{ productionType: "PROMESH", machine: "9" }, { productionType: "PROMESH" }, { productionType: "MELANGE", machine: "1" }, { machine: "1" }]) {
      const r = await request(app).post("/quality-control").set(auth(qc.token)).send(body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
    }
    const a = (await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "4" })).body.data;
    const b = (await request(app).post("/quality-control").set(auth(qc.token)).send({ productionType: "PROMESH", machine: "4" })).body.data;
    createdControls.push(a.id, b.id);
    const n = (ref) => Number(ref.split("-")[2]);
    expect(n(b.reference)).toBe(n(a.reference) + 1);
    // Recherche par référence de fiche qualité.
    const found = await request(app).get(`/quality-control?search=${a.reference}`).set(auth(qc.token));
    expect(found.body.data.map((c) => c.id)).toEqual([a.id]);
  });

  test("MACHINE TEST 7 — compte de production : ni création ni lecture ; fiches d'autres comptes jamais affichées ni comptées", async () => {
    const prodUser = await User.create({
      email: `qc-prod-${RUN_ID}@example.com`,
      passwordHash: await bcrypt.hash("StrongPass123!", 12),
      isActive: true,
      role: "responsable_logistique_achat",
    });
    createdUsers.push(prodUser.id);
    const prodToken = (await request(app).post("/auth/signin").send({ email: prodUser.email, password: "StrongPass123!" })).body.accessToken;
    expect((await request(app).post("/quality-control").set(auth(prodToken)).send({ productionType: "PROMESH", machine: "1" })).status).toBe(403);
    expect((await request(app).get("/quality-control").set(auth(prodToken))).status).toBe(403);

    // Fiche insérée directement au nom d'un compte NON contrôle qualité :
    // exclue des listes et statistiques (QC comme admin).
    const before = (await request(app).get("/quality-control/stats?period=all").set(auth(adminToken))).body.data.totals.total;
    const rogue = await QualityControl.create({
      reference: `QC-T-${String(RUN_ID).slice(-8)}`,
      productionType: "PROMESH",
      machine: "1",
      controllerUserId: prodUser.id,
      controllerEmail: prodUser.email,
      status: "CONFORME",
      validatedAt: new Date(),
    });
    createdControls.push(rogue.id);
    for (const token of [qc.token, adminToken]) {
      const list = (await request(app).get("/quality-control?limit=100&productionType=PROMESH&machine=1").set(auth(token))).body.data;
      expect(list.some((c) => c.id === rogue.id)).toBe(false);
      expect(list.every((c) => c.controllerEmail !== prodUser.email)).toBe(true);
    }
    const after = (await request(app).get("/quality-control/stats?period=all").set(auth(adminToken))).body.data.totals.total;
    expect(after).toBe(before);
  });
});
