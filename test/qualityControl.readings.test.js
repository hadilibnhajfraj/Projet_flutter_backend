"use strict";

// Module CONTRÔLE QUALITÉ — PRÉLÈVEMENTS périodiques : une fiche (machine + date +
// poste) porte plusieurs prélèvements (08:00, 11:07, 14:15…), chacun avec ses
// paramètres. Compte réel controle_qualite, relecture PostgreSQL. Les fiches
// créées (dates lointaines) sont supprimées en afterAll.

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
const cfg = require("../src/config/qualityControl");

const QC_EMAIL = "controle_qualite@cbi-tunisia.com";
const QC_PASSWORD = process.env.QC_TEST_PASSWORD || "ChangeMe123!";
const RUN_ID = Date.now();
const DAY = "2033-10-03";
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const created = [];
let adminId;

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });

async function dbReadings(controlId) {
  return sql(
    `SELECT r.id, to_char(r."readingTime", 'HH24:MI') AS time, r.status, r."validatedAt" IS NOT NULL AS validated,
            (SELECT count(*)::int FROM quality_control_items i WHERE i."readingId" = r.id) AS items
       FROM quality_control_readings r WHERE r."qualityControlId" = :id ORDER BY r."readingTime"`,
    { id: controlId }
  );
}

async function dbValue(readingId, key) {
  const [row] = await sql(`SELECT value, status, remark FROM quality_control_items WHERE "readingId" = :r AND "parameterKey" = :k`, { r: readingId, k: key });
  return row;
}

describe("Contrôle Qualité — prélèvements périodiques d'une fiche", () => {
  let qc;
  let admin;
  let ficheId;
  const reading = {};

  const post = (path, body) => request(app).post(path).set(auth(qc)).send(body);
  const put = (path, body) => request(app).put(path).set(auth(qc)).send(body);
  const get = (path, token = qc) => request(app).get(path).set(auth(token));

  beforeAll(async () => {
    qc = (await request(app).post("/auth/signin").send({ email: QC_EMAIL, password: QC_PASSWORD })).body.accessToken;
    const user = await User.create({ email: `qc-readings-admin-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash("StrongPass123!", 12), isActive: true, role: "superadmin" });
    adminId = user.id;
    admin = (await request(app).post("/auth/signin").send({ email: user.email, password: "StrongPass123!" })).body.accessToken;
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
    if (adminId) await User.destroy({ where: { id: adminId } });
    await sequelize.close();
  });

  test("configuration : catégories du prélèvement, paramètres ajoutés, unités seulement quand elles sont définies", async () => {
    const { data } = (await get("/quality-control/config")).body;
    expect(data.sections.map((s) => s.key)).toEqual(["controle_machine", "controle_promesh_4", "ligne", "chauffage", "machine", "physique"]);
    expect(data.sections.find((s) => s.key === "physique").scope).toBe("fiche"); // hors des prélèvements
    expect(data.readingIntervalMinutes).toBe(180);
    const by = Object.fromEntries(data.parameters.map((p) => [p.key, p]));
    expect(by.heure).toBeUndefined(); // l'heure appartient au prélèvement
    // PROMESH : contrôle d'un prélèvement, dans la catégorie unique « Contrôle Machine ».
    expect(by.diametre_bar).toBeUndefined(); // retiré de toutes les lignes
    expect(by.temperature_machine).toMatchObject({ scope: "reading", kind: "number", unit: "°C", lines: ["PROMESH"] }); // retirée de PROBAR
    expect(by.temperature_machine.byLine.PROMESH).toEqual({ section: "controle_machine", order: 1, label: "TEMPÉRATURE DE MACHINE" });
    // Température d'eau : commune aux deux lignes et à la liste propre à PROMESH 4.
    expect(by.temperature_eau).toMatchObject({ section: "machine", unit: "°C", lines: ["PROMESH", "PROBAR", "PROMESH:4"] });
    // Caractéristique du produit : niveau fiche (contrôle produit), plus dans un prélèvement.
    expect(by.dimensions_cote_1_long).toMatchObject({ unit: "mm", scope: "fiche", section: "physique", lines: ["PROMESH", "PROMESH:4"] });
    expect(by.fuite_air_comprime.options.map((o) => o.value)).toEqual(["Absent", "Présent"]);
    expect(by.fuite_air_comprime.kind).toBe("choice");
  });

  test("TEST — fiche PROMESH Machine 1 (03/10, Matin) + prélèvement 08:00 : une fiche, un prélèvement", async () => {
    const res = await post("/quality-control", {
      productionType: "PROMESH",
      machine: "1",
      productionDate: DAY,
      controlDate: DAY,
      controlTime: "20:10:56",
      poste: "matin",
      lot: "LOT-RELEVES",
      reading: {
        readingTime: "08:00",
        items: [
          { parameterKey: "temperature_machine", value: "20", status: "CONFORME" },
          { parameterKey: "temperature_eau", value: "185", status: "CONFORME", remark: "RAS" },
        ],
      },
    });
    expect(res.status).toBe(201);
    const c = res.body.data;
    ficheId = c.id;
    created.push(ficheId);
    reading.h08 = c.readingId;

    // Identification de la fiche.
    expect(c).toMatchObject({ productionType: "PROMESH", machine: "1", machineLabel: "Machine 1", poste: "matin", controllerEmail: QC_EMAIL, isValidated: false, status: "EN_COURS" });
    expect(c.reference).toMatch(/^QC-(PROMESH|PROBAR)-\d{6}$/);
    // Heure d'OUVERTURE (fiche) ≠ heure du PRÉLÈVEMENT.
    expect(c.controlTime).toBe("20:10:56");
    expect(c.readings).toHaveLength(1);
    expect(c.readings[0]).toMatchObject({ id: reading.h08, readingTime: "08:00", status: "EN_COURS", isValidated: false });
    expect(c.readings[0].counts).toEqual({ total: cfg.readingParametersFor("PROMESH").length, controlled: 2, conformes: 2, nonConformes: 0 });
    expect(c).toMatchObject({ readingsCount: 1, lastReadingTime: "08:00", suggestedNextReadingTime: "11:00" });
  });

  test("+ Nouveau prélèvement : 11:00 proposé, 11:07 saisi — le prélèvement 08:00 n'est pas modifié", async () => {
    const res = await post(`/quality-control/${ficheId}/readings`, {
      readingTime: "11:07",
      items: [{ parameterKey: "temperature_machine", value: "22", status: "CONFORME" }],
    });
    expect(res.status).toBe(201);
    reading.h11 = res.body.data.readingId;
    expect(reading.h11).not.toBe(reading.h08);
    expect(res.body.data.readings.map((r) => r.readingTime)).toEqual(["08:00", "11:07"]);
    expect(res.body.data.suggestedNextReadingTime).toBe("14:07");

    // 08:00 : vitesse = 20 ; 11:07 : vitesse = 22 — les deux conservées.
    expect(await dbValue(reading.h08, "temperature_machine")).toMatchObject({ value: "20", status: "CONFORME" });
    expect(await dbValue(reading.h11, "temperature_machine")).toMatchObject({ value: "22", status: "CONFORME" });
    expect(await dbValue(reading.h08, "temperature_eau")).toMatchObject({ value: "185", remark: "RAS" });
    expect(await dbValue(reading.h11, "temperature_eau")).toBeUndefined();
  });

  test("+ Nouveau prélèvement : 14:07 proposé, 14:15 saisi — trois prélèvements, une seule fiche (PostgreSQL)", async () => {
    const res = await post(`/quality-control/${ficheId}/readings`, {
      readingTime: "14:15",
      items: [{ parameterKey: "temperature_machine", value: "21", status: "CONFORME" }],
    });
    expect(res.status).toBe(201);
    reading.h14 = res.body.data.readingId;

    const [{ n }] = await sql(`SELECT count(*)::int n FROM quality_controls WHERE "productionType" = 'PROMESH' AND machine = '1' AND "productionDate" = :d AND "deletedAt" IS NULL`, { d: DAY });
    expect(n).toBe(1);
    const rows = await dbReadings(ficheId);
    expect(rows.map((r) => r.time)).toEqual(["08:00", "11:07", "14:15"]);
    expect(rows.map((r) => r.items)).toEqual([2, 1, 1]);

    const detail = (await get(`/quality-control/${ficheId}`)).body.data;
    expect(detail.readings.map((r) => r.readingTime)).toEqual(["08:00", "11:07", "14:15"]);
    expect(detail.readings.map((r) => r.items.find((i) => i.parameterKey === "temperature_machine").value)).toEqual(["20", "22", "21"]);
    expect(detail).toMatchObject({ readingsCount: 3, lastReadingTime: "14:15", controlTime: "20:10:56" });
    expect(detail.counts).toMatchObject({ controlled: 4, total: cfg.readingParametersFor("PROMESH").length * 3 });
  });

  test("heure déjà utilisée : 409 « Un prélèvement existe déjà pour 08:00. » + prélèvement existant ; heure invalide ou absente : 400", async () => {
    const dup = await post(`/quality-control/${ficheId}/readings`, { readingTime: "08:00" });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: "READING_TIME_EXISTS", existingReadingId: reading.h08, message: "Un prélèvement existe déjà pour 08:00." });
    // Déplacer 11:07 sur 14:15 : refusé de la même façon.
    const move = await put(`/quality-control/${ficheId}/readings/${reading.h11}`, { readingTime: "14:15" });
    expect(move.status).toBe(409);
    expect(move.body.existingReadingId).toBe(reading.h14);
    expect((await post(`/quality-control/${ficheId}/readings`, { readingTime: "25:00" })).status).toBe(400);
    expect((await post(`/quality-control/${ficheId}/readings`, {})).status).toBe(400);
    expect(await dbReadings(ficheId)).toHaveLength(3);
  });

  test("modification d'un prélèvement brouillon : seules ses valeurs changent, heure réelle modifiable, journal par prélèvement", async () => {
    const res = await put(`/quality-control/${ficheId}/readings/${reading.h11}`, {
      readingTime: "11:05",
      items: [
        { parameterKey: "temperature_machine", value: "23" },
        { parameterKey: "fuite_eau", value: "0.4", status: "NON_CONFORME", remark: "hors tolérance" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.readings.map((r) => r.readingTime)).toEqual(["08:00", "11:05", "14:15"]);
    expect(await dbValue(reading.h11, "temperature_machine")).toMatchObject({ value: "23", status: "CONFORME" });
    expect(await dbValue(reading.h08, "temperature_machine")).toMatchObject({ value: "20" });
    expect(await dbValue(reading.h14, "temperature_machine")).toMatchObject({ value: "21" });
    expect(await dbValue(reading.h08, "fuite_eau")).toBeUndefined();

    const history = res.body.data.history;
    expect(history.some((h) => h.action === "READING_CREATE" && h.readingTime === "14:15")).toBe(true);
    expect(history.some((h) => h.field === "readingTime" && h.oldValue === "11:07" && h.newValue === "11:05")).toBe(true);
    expect(history.some((h) => h.readingTime === "11:05" && h.parameterKey === "temperature_machine" && h.oldValue === "22" && h.newValue === "23")).toBe(true);
  });

  test("validation d'un prélèvement : NON CONFORME enregistré, prélèvement en lecture seule, fiche toujours ouverte", async () => {
    const res = await post(`/quality-control/${ficheId}/readings/${reading.h11}/validate`, {});
    expect(res.status).toBe(200);
    const r = res.body.data.readings.find((x) => x.id === reading.h11);
    expect(r).toMatchObject({ status: "NON_CONFORME", isValidated: true, nonConformParameters: ["FUITE D'EAU"] });
    expect(res.body.data.isValidated).toBe(false);
    expect(res.body.data.notificationsSent).toBeGreaterThanOrEqual(0);

    for (const call of [
      put(`/quality-control/${ficheId}/readings/${reading.h11}`, { items: [{ parameterKey: "temperature_machine", value: "99" }] }),
      post(`/quality-control/${ficheId}/readings/${reading.h11}/validate`, {}),
      request(app).delete(`/quality-control/${ficheId}/readings/${reading.h11}`).set(auth(qc)),
    ]) {
      const locked = await call;
      expect(locked.status).toBe(403);
      expect(locked.body.code).toBe("READING_LOCKED");
    }
    expect(await dbValue(reading.h11, "temperature_machine")).toMatchObject({ value: "23" });

    // Validation refusée sans données : un prélèvement vide reste brouillon.
    const empty = await post(`/quality-control/${ficheId}/readings`, { readingTime: "17:00", validate: true });
    expect(empty.status).toBe(422);
    expect(await dbReadings(ficheId)).toHaveLength(3);
  });

  test("suppression d'un prélèvement brouillon : lui seul disparaît ; prélèvement inconnu 404 ; admin en lecture seule (403)", async () => {
    const extra = await post(`/quality-control/${ficheId}/readings`, { readingTime: "17:20", items: [{ parameterKey: "temperature_eau", value: "3", status: "CONFORME" }] });
    expect(extra.status).toBe(201);
    expect(extra.body.data.readingsCount).toBe(4);
    expect((await request(app).delete(`/quality-control/${ficheId}/readings/${extra.body.data.readingId}`).set(auth(admin))).status).toBe(403);
    const del = await request(app).delete(`/quality-control/${ficheId}/readings/${extra.body.data.readingId}`).set(auth(qc));
    expect(del.status).toBe(200);
    expect(del.body.data.readings.map((r) => r.readingTime)).toEqual(["08:00", "11:05", "14:15"]);
    expect(del.body.data.history.some((h) => h.action === "READING_DELETE" && h.readingTime === "17:20")).toBe(true);
    expect((await put(`/quality-control/${ficheId}/readings/00000000-0000-4000-8000-000000000000`, {})).status).toBe(404);
    expect((await request(app).post(`/quality-control/${ficheId}/readings`).set(auth(admin)).send({ readingTime: "18:00" })).status).toBe(403);
    // Consultation admin : les prélèvements sont visibles.
    expect((await get(`/quality-control/${ficheId}`, admin)).body.data.readingsCount).toBe(3);
  });

  test("une seule fiche OUVERTE par machine / date / poste : 409 FICHE_EXISTS + fiche à rouvrir", async () => {
    const res = await post("/quality-control", { productionType: "PROMESH", machine: "1", productionDate: DAY, poste: "matin" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "FICHE_EXISTS", existingId: ficheId });
    const [{ n }] = await sql(`SELECT count(*)::int n FROM quality_controls WHERE "productionDate" = :d`, { d: DAY });
    expect(n).toBe(1); // rien créé (transaction annulée)
    // Autre poste ou autre machine : fiche distincte autorisée.
    const soir = await post("/quality-control", { productionType: "PROMESH", machine: "1", productionDate: DAY, poste: "soir" });
    expect(soir.status).toBe(201);
    created.push(soir.body.data.id);
    // …mais elle ne peut pas être déplacée sur le poste déjà ouvert.
    const moved = await put(`/quality-control/${soir.body.data.id}`, { poste: "matin" });
    expect(moved.status).toBe(409);
    expect(moved.body.existingId).toBe(ficheId);

    // Poste du soir : les prélèvements après minuit suivent ceux du soir.
    await post(`/quality-control/${soir.body.data.id}/readings`, { readingTime: "22:30" });
    const night = await post(`/quality-control/${soir.body.data.id}/readings`, { readingTime: "01:30" });
    expect(night.body.data.readings.map((r) => r.readingTime)).toEqual(["22:30", "01:30"]);
    expect(night.body.data).toMatchObject({ lastReadingTime: "01:30", suggestedNextReadingTime: "04:30" });
  });

  test("historique et statistiques : 1 contrôle, 3 prélèvements (jamais 3 contrôles)", async () => {
    const list = await get(`/quality-control?productionType=PROMESH&machine=1&from=${DAY}&to=${DAY}&limit=100`);
    const row = list.body.data.find((c) => c.id === ficheId);
    expect(row).toMatchObject({ readingsCount: 3, lastReadingTime: "14:15", posteLabel: "Matin", controllerEmail: QC_EMAIL });
    expect(row.readings.map((r) => r.readingTime)).toEqual(["08:00", "11:05", "14:15"]);
    expect(row.items).toBeUndefined(); // liste : pas le détail des paramètres

    const stats = (await get("/quality-control/stats?period=all")).body.data;
    const [db] = await sql(
      `SELECT count(DISTINCT c.id)::int controles, count(r.id)::int releves
         FROM quality_controls c LEFT JOIN quality_control_readings r ON r."qualityControlId" = c.id
        WHERE c."deletedAt" IS NULL AND c."controllerUserId" IN (SELECT id FROM users WHERE email = :e)`,
      { e: QC_EMAIL }
    );
    expect(stats.totals.total).toBe(db.controles);
    expect(stats.totals.releves).toBe(db.releves);
    expect(stats.totals.releves).toBeGreaterThan(stats.totals.total);
    const m1 = stats.lines.find((l) => l.type === "PROMESH").machines.find((m) => m.machine === "1");
    expect(m1.releves).toBeGreaterThanOrEqual(3);

    const cmp = (await get(`/quality-control/comparison?periodAStart=2033-09-01&periodAEnd=2033-09-30&periodBStart=${DAY}&periodBEnd=${DAY}&productionType=PROMESH&machine=1`)).body.data;
    expect(cmp.periodB).toMatchObject({ total: 1, releves: 3, parametresControles: 5, parametresNonConformes: 1 });
    // Période A vide : aucune variation calculée (comparaison impossible).
    expect(cmp.evolution.releves).toEqual({ absolue: null, relative: null });
    expect(cmp.dataStatus).toBe("insufficient");
    expect(cmp.byParameter.find((p) => p.key === "fuite_eau")).toMatchObject({ periodB: 1 });
    expect(cmp.byParameter.find((p) => p.key === "temperature_machine").controlesB).toBe(3);
  });

  test("validation de la fiche : prélèvements brouillons validés, résultat global NON CONFORME, tout en lecture seule", async () => {
    const res = await post(`/quality-control/${ficheId}/validate`, { status: "CONFORME" });
    expect(res.status).toBe(200);
    const c = res.body.data;
    // Un prélèvement NON CONFORME force le résultat de la fiche.
    expect(c).toMatchObject({ isValidated: true, status: "NON_CONFORME", controlTime: "20:10:56" });
    expect(c.readings.map((r) => [r.readingTime, r.status, r.isValidated])).toEqual([
      ["08:00", "CONFORME", true],
      ["11:05", "NON_CONFORME", true],
      ["14:15", "CONFORME", true],
    ]);

    for (const call of [
      post(`/quality-control/${ficheId}/readings`, { readingTime: "18:00" }),
      put(`/quality-control/${ficheId}/readings/${reading.h08}`, { items: [{ parameterKey: "temperature_machine", value: "1" }] }),
      request(app).delete(`/quality-control/${ficheId}/readings/${reading.h14}`).set(auth(qc)),
      put(`/quality-control/${ficheId}`, { lot: "AUTRE" }),
    ]) {
      const locked = await call;
      expect(locked.status).toBe(403);
      expect(locked.body.code).toBe("CONTROL_LOCKED");
    }
    expect(await dbValue(reading.h08, "temperature_machine")).toMatchObject({ value: "20" });
    expect((await dbReadings(ficheId)).every((r) => r.validated)).toBe(true);

    // Fiche clôturée : une nouvelle fiche peut être ouverte pour le même poste.
    const next = await post("/quality-control", { productionType: "PROMESH", machine: "1", productionDate: DAY, poste: "matin" });
    expect(next.status).toBe(201);
    created.push(next.body.data.id);
    // Sans prélèvement : validation refusée.
    const empty = await post(`/quality-control/${next.body.data.id}/validate`, {});
    expect(empty.status).toBe(422);
    expect(empty.body.errors.map((e) => e.message)).toContain("Au moins un prélèvement de contrôle est obligatoire");
  });

  test("export Excel : colonnes Prélèvements / Dernier prélèvement, feuille Paramètres par prélèvement", async () => {
    const ExcelJS = require("exceljs");
    const res = await request(app)
      .get(`/quality-control/export?format=xlsx&productionType=PROMESH&machine=1&from=${DAY}&to=${DAY}`)
      .set(auth(qc))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (d) => chunks.push(d));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const detail = wb.getWorksheet("Détail des contrôles");
    expect(detail.getRow(4).values.slice(1)).toEqual(expect.arrayContaining(["Prélèvements", "Dernier prélèvement"]));
    const rows = [];
    detail.eachRow((r, n) => n > 4 && rows.push(r.values));
    const fiche = rows.find((v) => v[9] === 3);
    expect(fiche[10]).toBe("14:15");
    const params = [];
    wb.getWorksheet("Paramètres").eachRow((r, n) => n > 4 && params.push(r.values));
    expect(params.filter((v) => v[5] === "TEMPÉRATURE DE MACHINE").map((v) => `${v[4]}=${v[6]}`).sort()).toEqual(["08:00=20", "11:05=23", "14:15=21"]);
  });
});
