"use strict";

// Archivage automatique des brouillons Production — délai de 8h (ancien : 2h).
// Exécute le VRAI sweep (sweepDraftArchive, celui du cron existant) avec un
// "now" fixé, dans une transaction ANNULÉE à la fin : aucun effet sur les
// autres brouillons ni sur les données réelles de la base.

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
  verifyConnection: jest.fn().mockResolvedValue({ ok: true }),
  maskEmail: (e) => e,
}));

require("dotenv").config();
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");
const draftArchive = require("../src/modules/production-draft-archive/services/draftArchive.service");

const H = 3600 * 1000;
const NOW = new Date("2026-09-29T12:00:00.000Z");
const ago = (ms) => new Date(NOW.getTime() - ms);

describe("Production Draft Archive — délai de 8h depuis createdAt", () => {
  let t;
  let prod1;
  const ids = {};
  let probarAfterFirstSweep;

  async function insertPromesh(key, { status, createdAt, updatedAt = createdAt }) {
    const [row] = await sequelize.query(
      `INSERT INTO por_promesh (id, "dateProduction", machine, poste, status, "isLocked", "createdBy", "createdAt", "updatedAt",
                                "archivedAt", "archivedBy", "archiveReason")
       VALUES (gen_random_uuid(), '2026-09-29', '1', 'matin', :status, :locked, :u, :c, :m,
               CASE WHEN :status = 'ARCHIVED' THEN CAST(:c AS timestamptz) + interval '2 hours' END,
               CASE WHEN :status = 'ARCHIVED' THEN 'SYSTEM' END,
               CASE WHEN :status = 'ARCHIVED' THEN 'ancien archivage (test)' END)
       RETURNING id`,
      { replacements: { status, locked: status === "VALIDE", u: prod1.id, c: createdAt, m: updatedAt }, type: QueryTypes.SELECT, transaction: t }
    );
    ids[key] = row.id;
  }

  async function status(key) {
    const [r] = await sequelize.query(`SELECT status, "archivedAt", "archiveReason" FROM por_promesh WHERE id = :id`, {
      replacements: { id: ids[key] },
      type: QueryTypes.SELECT,
      transaction: t,
    });
    return r;
  }

  async function logsFor(key) {
    return sequelize.query(`SELECT * FROM production_draft_archive_log WHERE "ficheId" = :id`, {
      replacements: { id: ids[key] },
      type: QueryTypes.SELECT,
      transaction: t,
    });
  }

  beforeAll(async () => {
    prod1 = await User.findOne({ where: { email: "production_1@cbi-tunisia.com" } });
    t = await sequelize.transaction();

    await insertPromesh("t1_now", { status: "BROUILLON", createdAt: NOW });
    await insertPromesh("t2_7h59", { status: "BROUILLON", createdAt: ago(7 * H + 59 * 60 * 1000) });
    await insertPromesh("t3_8h", { status: "BROUILLON", createdAt: ago(8 * H) });
    await insertPromesh("t4_9h", { status: "BROUILLON", createdAt: ago(9 * H) });
    await insertPromesh("t5_valide_10h", { status: "VALIDE", createdAt: ago(10 * H) });
    // Test 6 : créée il y a 5h, modifiée à l'instant (updatedAt = NOW).
    await insertPromesh("t6_modified", { status: "BROUILLON", createdAt: ago(5 * H), updatedAt: NOW });
    await insertPromesh("t7_archived", { status: "ARCHIVED", createdAt: ago(10 * H) });

    // PROBAR (industrial_records) — même règle, même sweep.
    const [pb] = await sequelize.query(
      `INSERT INTO industrial_records (id, module, machine, poste, "dateFiche", statut, "createdBy", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), 'probar', '1', 'matin', '2026-09-29', 'enregistree', :u, :c, :c) RETURNING id`,
      { replacements: { u: prod1.id, c: ago(8 * H + 1000) }, type: QueryTypes.SELECT, transaction: t }
    );
    ids.probar_8h = pb.id;
    const [pb2] = await sequelize.query(
      `INSERT INTO industrial_records (id, module, machine, poste, "dateFiche", statut, "createdBy", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), 'probar', '1', 'matin', '2026-09-29', 'enregistree', :u, :c, :c) RETURNING id`,
      { replacements: { u: prod1.id, c: ago(3 * H) }, type: QueryTypes.SELECT, transaction: t }
    );
    ids.probar_3h = pb2.id;

    await draftArchive.sweepDraftArchive(NOW, t);
    // Statut PROBAR relevé juste après CE passage (les tests 6/7 relancent le
    // sweep à NOW+3h / NOW+24h, qui archiverait légitimement la fiche de 3h).
    const rows = await sequelize.query(`SELECT id, statut FROM industrial_records WHERE id IN (:ids)`, {
      replacements: { ids: [ids.probar_8h, ids.probar_3h] },
      type: QueryTypes.SELECT,
      transaction: t,
    });
    probarAfterFirstSweep = Object.fromEntries(rows.map((r) => [r.id, r.statut]));
  }, 30000);

  afterAll(async () => {
    await t.rollback(); // aucune donnée réelle modifiée
    await sequelize.close();
  });

  test("configuration : 8h (ancienne valeur 2h)", () => {
    expect(draftArchive.DRAFT_ARCHIVE_DELAY_HOURS).toBe(8);
    expect(draftArchive.DRAFT_ARCHIVE_DELAY_MS).toBe(8 * H);
    expect(draftArchive.REASON).toBe("Automatically archived after 8 hours in draft.");
  });

  test("Test 1 — createdAt = maintenant → reste active", async () => {
    expect((await status("t1_now")).status).toBe("BROUILLON");
  });

  test("Test 2 — createdAt = maintenant − 7h59 → reste active", async () => {
    expect((await status("t2_7h59")).status).toBe("BROUILLON");
    expect(await logsFor("t2_7h59")).toHaveLength(0);
  });

  test("Test 3 — createdAt = maintenant − 8h → archivée (seuil inclus) + journal", async () => {
    const s = await status("t3_8h");
    expect(s.status).toBe("ARCHIVED");
    expect(new Date(s.archivedAt).toISOString()).toBe(NOW.toISOString());
    expect(s.archiveReason).toBe("Automatically archived after 8 hours in draft.");

    const [log] = await logsFor("t3_8h");
    expect(log).toMatchObject({ ficheType: "PROMESH", action: "AUTO_ARCHIVED", reason: "Automatically archived after 8 hours in draft.", userEmail: "production_1@cbi-tunisia.com" });
    // expiresAt = createdAt + 8h exactement.
    expect(new Date(log.expiresAt).getTime() - new Date(log.ficheCreatedAt).getTime()).toBe(8 * H);

    const [notif] = await sequelize.query(
      `SELECT message FROM notifications WHERE "userId" = :u AND type = 'production_draft_archived' ORDER BY "createdAt" DESC LIMIT 1`,
      { replacements: { u: prod1.id }, type: QueryTypes.SELECT, transaction: t }
    );
    expect(notif.message).toContain("plus de 8 heures");
  });

  test("Test 4 — createdAt = maintenant − 9h → archivée", async () => {
    expect((await status("t4_9h")).status).toBe("ARCHIVED");
    expect(await logsFor("t4_9h")).toHaveLength(1);
  });

  test("Test 5 — fiche terminée (VALIDE) créée il y a 10h → jamais archivée", async () => {
    expect((await status("t5_valide_10h")).status).toBe("VALIDE");
    expect(await logsFor("t5_valide_10h")).toHaveLength(0);
  });

  test("Test 6 — fiche modifiée : le délai part toujours de createdAt (jamais updatedAt)", async () => {
    // Créée il y a 5h, modifiée à l'instant : active maintenant…
    expect((await status("t6_modified")).status).toBe("BROUILLON");
    // …et archivée à createdAt + 8h (NOW + 3h), bien que modifiée il y a
    // seulement 3h à ce moment-là : la modification ne repousse rien.
    await draftArchive.sweepDraftArchive(new Date(NOW.getTime() + 3 * H - 1000), t);
    expect((await status("t6_modified")).status).toBe("BROUILLON"); // 7h59m59s
    await draftArchive.sweepDraftArchive(new Date(NOW.getTime() + 3 * H), t);
    expect((await status("t6_modified")).status).toBe("ARCHIVED"); // 8h pile
  });

  test("Test 7 — fiche déjà ARCHIVED → non retraitée (pas de 2e archivage ni de journal)", async () => {
    const before = await status("t7_archived");
    await draftArchive.sweepDraftArchive(new Date(NOW.getTime() + 24 * H), t);
    const after = await status("t7_archived");
    expect(after.status).toBe("ARCHIVED");
    expect(new Date(after.archivedAt).toISOString()).toBe(new Date(before.archivedAt).toISOString());
    expect(after.archiveReason).toBe("ancien archivage (test)");
    expect(await logsFor("t7_archived")).toHaveLength(0);
    // Les fiches archivées au 1er passage ne sont pas ré-journalisées non plus.
    expect(await logsFor("t3_8h")).toHaveLength(1);
  });

  test("PROBAR — même règle : 8h+ archivée, 3h active", async () => {
    const byId = probarAfterFirstSweep;
    expect(byId[ids.probar_8h]).toBe("archivee");
    expect(byId[ids.probar_3h]).toBe("enregistree");
  });
});
