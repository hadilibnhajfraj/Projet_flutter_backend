"use strict";

// Finance — « Nouvelle expédition » (POST /finance/shipments, Bons de livraison).
//
// Régression : HTTP 500 « Échec du traitement du Bon de Livraison » après la
// SUPPRESSION d'une expédition. Cause : « Shipment # » (SH-00001) et la
// référence de repli (SHIP-{année}-000001) étaient calculés par COUNT(...) + 1
// alors que ces deux colonnes sont UNIQUES. Dès qu'une expédition est supprimée
// (suppression physique), le compteur redescend sous le plus grand numéro
// existant → numéro déjà pris → violation d'unicité à CHAQUE import suivant
// (les trois nouvelles tentatives recomptent la même valeur). Même défaut que
// celui déjà corrigé pour les bons de commande (PO #).
//
// Couvre aussi : fichier illisible (enregistré, à vérifier manuellement),
// nouvelle tentative après une erreur temporaire, absence de doublon,
// métadonnées et consultation du document, codes d'erreur et logs structurés.

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

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcrypt");
const { QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const logger = require("../src/utils/logger");
const User = require("../src/models/User");
const repo = require("../src/modules/finance/repositories/finance.repository");
const { UPLOAD_DIR } = require("../src/middleware/financeDocumentUpload.middleware");

const RUN_ID = Date.now();
const PASSWORD = "StrongPass123!";
// PDF non lisible par l'OCR : le document doit quand même être enregistré.
const pdf = (label) => Buffer.from(`%PDF-1.4 ${label} ${RUN_ID}`);

const sql = (query, replacements) => sequelize.query(query, { replacements, type: QueryTypes.SELECT });
const num = (shipmentNumber) => Number(String(shipmentNumber).replace("SH-", ""));

describe("Finance — import d'un Bon de Livraison (Nouvelle expédition)", () => {
  let token;
  let userId;
  const created = [];

  const upload = (buffer, filename = "bl.pdf") =>
    request(app).post("/finance/shipments").set("Authorization", `Bearer ${token}`).attach("documents", buffer, { filename, contentType: "application/pdf" });
  const remember = (res) => {
    if (res.body?.data?.id) created.push(res.body.data.id);
    return res;
  };
  const countMine = async () => (await sql(`SELECT COUNT(*)::int n FROM finance_shipments WHERE "createdBy" = :userId`, { userId }))[0].n;

  beforeAll(async () => {
    const user = await User.create({ email: `finance-bl-${RUN_ID}@example.com`, passwordHash: await bcrypt.hash(PASSWORD, 12), isActive: true, role: "finance_probar" });
    userId = user.id;
    token = (await request(app).post("/auth/signin").send({ email: user.email, password: PASSWORD })).body.accessToken;
  }, 30000);

  afterAll(async () => {
    const mine = await sql(`SELECT id FROM finance_shipments WHERE "createdBy" = :userId`, { userId });
    const ids = [...new Set([...created, ...mine.map((r) => r.id)])];
    if (ids.length) {
      const docs = await sql(`SELECT "storedFileName" f FROM finance_documents WHERE module = 'SHIPMENT' AND "entityId" IN (:ids)`, { ids });
      for (const d of docs) fs.promises.unlink(path.join(UPLOAD_DIR, d.f)).catch(() => {});
      await sequelize.query(`DELETE FROM finance_documents WHERE module = 'SHIPMENT' AND "entityId" IN (:ids)`, { replacements: { ids } });
      await sequelize.query(`DELETE FROM finance_shipment_items WHERE "shipmentId" IN (:ids)`, { replacements: { ids } });
      await sequelize.query(`DELETE FROM finance_activities WHERE "entityId" IN (:ids)`, { replacements: { ids } }).catch(() => {});
      await sequelize.query(`DELETE FROM finance_shipments WHERE id IN (:ids)`, { replacements: { ids } });
    }
    await sequelize.query(`DELETE FROM finance_activities WHERE "userId" = :userId`, { replacements: { userId } }).catch(() => {});
    await User.destroy({ where: { id: userId } });
    await sequelize.close();
  }, 30000);

  test("TEST 1/2/6/7 — deux PDF importés : 201, numéros distincts, métadonnées et document enregistrés, document consultable", async () => {
    const a = remember(await upload(pdf("premier"), "BL-premier.pdf"));
    const b = remember(await upload(pdf("second"), "BL-second.pdf"));
    expect([a.status, b.status]).toEqual([201, 201]);
    for (const res of [a, b]) {
      expect(res.body.success).toBe(true);
      expect(res.body.data.shipmentNumber).toMatch(/^SH-\d{5,}$/);
      expect(res.body.data.reference).toMatch(/^SHIP-\d{4}-\d{6}$/);
    }
    expect(num(b.body.data.shipmentNumber)).toBeGreaterThan(num(a.body.data.shipmentNumber));
    expect(b.body.data.reference).not.toBe(a.body.data.reference);
    // PDF illisible : document REÇU et enregistré, traitement automatique incomplet (à vérifier manuellement).
    expect(a.body.data.status).toBe("OCR_FAILED");

    // Base : expédition + document associés, auteur et métadonnées du fichier.
    const [row] = await sql(`SELECT "shipmentNumber", reference, status, "createdBy" FROM finance_shipments WHERE id = :id`, { id: a.body.data.id });
    expect(row).toMatchObject({ shipmentNumber: a.body.data.shipmentNumber, reference: a.body.data.reference, status: "OCR_FAILED", createdBy: userId });
    const docs = await sql(`SELECT "originalName", "storedFileName", "mimeType", "fileSize", "uploadedBy" FROM finance_documents WHERE module = 'SHIPMENT' AND "entityId" = :id`, { id: a.body.data.id });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ originalName: "BL-premier.pdf", mimeType: "application/pdf", uploadedBy: userId });
    expect(Number(docs[0].fileSize)).toBe(pdf("premier").length);
    // Fichier réellement présent sur le disque, et document renvoyé par l'API (consultation).
    expect(fs.existsSync(path.join(UPLOAD_DIR, docs[0].storedFileName))).toBe(true);
    const detail = await request(app).get(`/finance/shipments/${a.body.data.id}`).set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.documents).toHaveLength(1);
    expect(detail.body.data.documents[0].originalName).toBe("BL-premier.pdf");
    expect(detail.body.data.documents[0].fileUrl).toBeTruthy();
  }, 120000);

  test("RÉGRESSION — après la suppression d'une expédition, l'import suivant réussit (numéros jamais réutilisés ni en doublon)", async () => {
    const a = remember(await upload(pdf("a")));
    const b = remember(await upload(pdf("b")));
    expect([a.status, b.status]).toEqual([201, 201]);

    // Suppression physique de la PREMIÈRE : COUNT(SH-%) redescend sous le plus grand numéro.
    const del = await request(app).delete(`/finance/shipments/${a.body.data.id}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);

    const c = remember(await upload(pdf("c")));
    expect(c.status).toBe(201); // avant correction : 500 « Échec du traitement du Bon de Livraison »
    expect(num(c.body.data.shipmentNumber)).toBeGreaterThan(num(b.body.data.shipmentNumber));
    expect(c.body.data.reference).not.toBe(b.body.data.reference);

    const d = remember(await upload(pdf("d")));
    expect(d.status).toBe(201);
    expect(num(d.body.data.shipmentNumber)).toBe(num(c.body.data.shipmentNumber) + 1);

    // Aucun doublon de numéro ni de référence dans la table.
    const [dups] = await sql(`SELECT (COUNT(*) - COUNT(DISTINCT "shipmentNumber"))::int numbers, (COUNT(*) - COUNT(DISTINCT reference))::int refs FROM finance_shipments WHERE "shipmentNumber" IS NOT NULL`);
    expect(dups).toEqual({ numbers: 0, refs: 0 });
  }, 120000);

  test("imports simultanés : chacun reçoit son propre numéro", async () => {
    const results = await Promise.all([1, 2, 3, 4].map((i) => upload(pdf(`simultane-${i}`), `BL-${i}.pdf`)));
    results.forEach(remember);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.data.shipmentNumber)).size).toBe(4);
    expect(new Set(results.map((r) => r.body.data.reference)).size).toBe(4);
  }, 180000);

  test("TEST 4/8 — erreur d'enregistrement en base : 500 DATABASE_FAILED, message clair, log structuré, rien de partiel ; la nouvelle tentative réussit", async () => {
    const before = await countMine();
    const filesBefore = fs.readdirSync(UPLOAD_DIR).length;
    const errorLog = jest.spyOn(logger, "error").mockImplementation(() => {});
    const boom = Object.assign(new Error("connexion interrompue"), { name: "SequelizeDatabaseError", parent: { code: "08006", detail: null } });
    const spy = jest.spyOn(repo, "createShipment").mockRejectedValueOnce(boom);

    const res = await upload(pdf("erreur-temporaire"));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: "DATABASE_FAILED", step: "DATABASE_TRANSACTION", message: "Document reçu, mais l'enregistrement en base a échoué." });
    // Aucun détail SQL ni chemin interne renvoyé au client : uniquement code, étape et message.
    expect(Object.keys(res.body).sort()).toEqual(["code", "message", "step", "success"]);
    expect(JSON.stringify(res.body)).not.toMatch(/Sequelize|08006|connexion interrompue|uploads/);
    // Rien de partiel : ni expédition, ni fichier orphelin.
    expect(await countMine()).toBe(before);
    expect(fs.readdirSync(UPLOAD_DIR).length).toBe(filesBefore);
    // Log structuré : étape, code, statut HTTP, cause — jamais le jeton.
    const entry = errorLog.mock.calls.find((c) => c[0] === "[FINANCE UPLOAD] FAILED");
    expect(entry).toBeTruthy();
    expect(entry[1]).toMatchObject({ flow: "DELIVERY_NOTE", step: "DATABASE_TRANSACTION", code: "DATABASE_FAILED", httpStatus: 500, error: "connexion interrompue", name: "SequelizeDatabaseError", pgCode: "08006", userId });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(token);
    errorLog.mockRestore();

    // Nouvelle tentative après l'erreur temporaire : enregistrée normalement, une seule fois.
    const retry = remember(await upload(pdf("erreur-temporaire")));
    expect(retry.status).toBe(201);
    expect(await countMine()).toBe(before + 1);
  }, 120000);

  test("codes d'erreur : stockage (FILESYSTEM_FAILED), lecture du PDF (PDF_EXTRACTION_FAILED), inattendue (UNKNOWN_ERROR), aucun fichier (FILE_UPLOAD_FAILED)", async () => {
    const errorLog = jest.spyOn(logger, "error").mockImplementation(() => {});
    const before = await countMine();

    const disk = jest.spyOn(repo, "createShipment").mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    const fsRes = await upload(pdf("disque"));
    disk.mockRestore();
    expect(fsRes.status).toBe(500);
    expect(fsRes.body).toMatchObject({ code: "FILESYSTEM_FAILED", message: "Une erreur de stockage empêche l'enregistrement du fichier." });

    const extraction = require("../src/modules/finance/services/deliveryNoteFieldExtraction.service");
    const ex = jest.spyOn(extraction, "extractDeliveryNoteFields").mockRejectedValueOnce(new Error("structure PDF invalide"));
    const exRes = await upload(pdf("extraction"));
    ex.mockRestore();
    expect(exRes.status).toBe(422);
    expect(exRes.body).toMatchObject({ code: "PDF_EXTRACTION_FAILED", step: "EXTRACTION", message: "Impossible de lire le PDF. Vérifiez que le fichier est valide." });

    const unknown = jest.spyOn(repo, "createShipment").mockRejectedValueOnce(new Error("imprévu"));
    const unRes = await upload(pdf("inconnu"));
    unknown.mockRestore();
    expect(unRes.status).toBe(500);
    expect(unRes.body).toMatchObject({ code: "UNKNOWN_ERROR", step: "DATABASE_TRANSACTION" });

    const none = await request(app).post("/finance/shipments").set("Authorization", `Bearer ${token}`);
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({ code: "FILE_UPLOAD_FAILED" });

    // Aucun de ces échecs n'a laissé d'expédition.
    expect(await countMine()).toBe(before);
    expect(errorLog.mock.calls.filter((c) => c[0] === "[FINANCE UPLOAD] FAILED").map((c) => c[1].code)).toEqual(["FILESYSTEM_FAILED", "PDF_EXTRACTION_FAILED", "UNKNOWN_ERROR"]);
    errorLog.mockRestore();
  }, 120000);

  test("taille des fichiers : limite de 25 Mo par fichier — inférieur et proche de la limite acceptés, au-delà → 413 clair, sans 500 ni fichier restant", async () => {
    const MB = 1024 * 1024;
    const sized = (bytes) => Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(bytes - 9, 32)]);
    const { MAX_FILE_MB } = require("../src/middleware/financeDocumentUpload.middleware");
    expect(MAX_FILE_MB).toBe(25);

    // 12 Mo (refusé par l'ancienne limite de 10 Mo) et 24,9 Mo (proche de la limite) : enregistrés.
    for (const [label, bytes] of [["12mo", 12 * MB], ["24_9mo", Math.floor(24.9 * MB)]]) {
      const ok = remember(await upload(sized(bytes), `BL-${label}.pdf`));
      expect(ok.status).toBe(201);
      const [doc] = await sql(`SELECT "fileSize", "storedFileName" FROM finance_documents WHERE module = 'SHIPMENT' AND "entityId" = :id`, { id: ok.body.data.id });
      expect(Number(doc.fileSize)).toBe(bytes);
      expect(fs.statSync(path.join(UPLOAD_DIR, doc.storedFileName)).size).toBe(bytes);
    }

    // Au-delà de 25 Mo : refus du middleware — 413, message explicite, rien de créé.
    const before = await countMine();
    const filesBefore = fs.readdirSync(UPLOAD_DIR).length;
    const errorLog = jest.spyOn(logger, "error").mockImplementation(() => {});
    const warnLog = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const tooBig = await upload(sized(25 * MB + 1), "BL-trop-gros.pdf");
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toEqual({ success: false, code: "FILE_TOO_LARGE", step: "FILE_RECEIVED", message: "Le fichier dépasse la taille maximale autorisée de 25 Mo.", maxFileMb: 25 });
    expect(await countMine()).toBe(before);
    expect(fs.readdirSync(UPLOAD_DIR).length).toBe(filesBefore); // aucun fichier temporaire laissé
    // Un seul refus journalisé, jamais transformé en erreur 500 du traitement.
    expect(warnLog.mock.calls.filter((c) => c[0] === "[FINANCE UPLOAD] REJECTED").map((c) => [c[1].code, c[1].httpStatus])).toEqual([["FILE_TOO_LARGE", 413]]);
    expect(errorLog.mock.calls.filter((c) => c[0] === "[FINANCE UPLOAD] FAILED")).toEqual([]);

    // Plusieurs fichiers dont UN trop volumineux : toute la requête est refusée, aucun fichier conservé.
    const mixed = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf("petit"), { filename: "petit.pdf", contentType: "application/pdf" })
      .attach("documents", sized(25 * MB + 1024), { filename: "gros.pdf", contentType: "application/pdf" });
    expect(mixed.status).toBe(413);
    expect(await countMine()).toBe(before);
    expect(fs.readdirSync(UPLOAD_DIR).length).toBe(filesBefore);
    errorLog.mockRestore();
    warnLog.mockRestore();

    // Type de fichier refusé : toujours 400, avec un code.
    const exe = await request(app).post("/finance/shipments").set("Authorization", `Bearer ${token}`).attach("documents", Buffer.from("MZ"), { filename: "virus.exe", contentType: "application/octet-stream" });
    expect(exe.status).toBe(400);
    expect(exe.body).toMatchObject({ success: false, code: "FILE_TYPE_NOT_ALLOWED" });
  }, 300000);

  test("TEST 5 — numéro de BL déjà importé : 409 DUPLICATE_DOCUMENT, aucun doublon créé, document existant conservé", async () => {
    const extraction = require("../src/modules/finance/services/deliveryNoteFieldExtraction.service");
    const real = extraction.extractDeliveryNoteFields;
    const deliveryNumber = `BL-TEST-${RUN_ID}`;
    // Le numéro de BL est lu de façon fiable (même document importé deux fois).
    const spy = jest.spyOn(extraction, "extractDeliveryNoteFields").mockImplementation(async (args) => {
      const out = await real(args);
      out.deliveryNumber = { value: deliveryNumber, confidence: 0.99 };
      return out;
    });
    const warnLog = jest.spyOn(logger, "warn").mockImplementation(() => {});

    const first = remember(await upload(pdf("doublon"), "BL-doublon.pdf"));
    expect(first.status).toBe(201);
    expect(first.body.data.reference).toBe(deliveryNumber);
    const before = await countMine();
    const filesBefore = fs.readdirSync(UPLOAD_DIR).length;

    const second = await upload(pdf("doublon"), "BL-doublon.pdf");
    spy.mockRestore();
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ success: false, code: "DUPLICATE_DOCUMENT", message: `Le document a déjà été importé (Bon de Livraison n° ${deliveryNumber}).` });
    expect(await countMine()).toBe(before);
    expect(fs.readdirSync(UPLOAD_DIR).length).toBe(filesBefore); // fichier de la seconde tentative retiré
    expect(warnLog.mock.calls.some((c) => c[0] === "[FINANCE UPLOAD] REJECTED" && c[1].code === "DUPLICATE_DOCUMENT")).toBe(true);
    warnLog.mockRestore();
    // Le document d'origine est toujours là.
    const docs = await sql(`SELECT "originalName" FROM finance_documents WHERE module = 'SHIPMENT' AND "entityId" = :id`, { id: first.body.data.id });
    expect(docs).toEqual([{ originalName: "BL-doublon.pdf" }]);
  }, 120000);
});
