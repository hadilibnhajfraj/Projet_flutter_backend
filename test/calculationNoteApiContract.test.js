"use strict";

// Contrat JSON de l'API « Notes de calcul » (types réels de chaque champ lu
// par l'application Flutter) — contre la base de DÉVELOPPEMENT locale.
// Régression couverte : `summary.byCreator` (tableau) était lu côté Flutter
// comme un nombre → « type 'List<dynamic>' is not a subtype of type 'num?' ».
//
// Cas réels créés par l'API avec de vrais comptes : note sans document, note à
// plusieurs documents, en attente, validée, refusée, annulée ; réponses lues
// par le créateur, le validateur (Wethek) et le back-office (connexion réelle,
// BACKOFFICE_PASSWORD). Si CALCULATION_NOTES_CONTRACT_DUMP est défini, les
// réponses brutes y sont écrites pour être relues par les modèles Dart
// (test/calculation_note_api_contract_test.dart côté Flutter).
// Tout ce que le test crée est retiré à la fin ; compteur annuel restauré.

const os = require("os");
const fs = require("fs");
const path = require("path");

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "nc-contract-"));
process.env.CALCULATION_NOTES_STORAGE_DIR = STORAGE;
const DUMP = process.env.CALCULATION_NOTES_CONTRACT_DUMP || null;

jest.mock("../src/utils/mailer", () => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "test" }), verifyConnection: jest.fn().mockResolvedValue({ ok: true }), maskEmail: (e) => e }));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));

const request = require("supertest");
const JSZip = require("jszip");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const { tunisYear } = require("../src/modules/calculation-notes/services/calculationNote.service");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");
const { purgeCalculationNotes } = require("./helpers/calculationNotes");

const PASSWORD = process.env.BACKOFFICE_PASSWORD;
const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const YEAR = tunisYear();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const createdIds = [];
let counterBefore;
let C;
let R;
let V;
let BO;
let PROJECT;
const notes = {};

const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });
async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  return { user: u, auth: tokenFor(u) };
}
async function ooxml() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", "<w/>");
  return zip.generateAsync({ type: "nodebuffer" });
}
async function create(files = []) {
  const r = request(app).post("/calculation-notes").set(C.auth).field("projectId", PROJECT.id).field("requesterId", R.user.id).field("commentaire", "Contrat API");
  if (files.length) {
    r.field("commentaires", JSON.stringify(files.map((_, i) => `Commentaire ${i + 1}`)));
    r.field("types", JSON.stringify(files.map((_, i) => (i === 0 ? "note_de_calcul" : null))));
  }
  for (const [buf, name] of files) r.attach("files", buf, name);
  const res = await r;
  expect(res.status).toBe(201);
  createdIds.push(res.body.data.id);
  return res.body.data;
}

function dump(name, body) {
  if (!DUMP) return;
  fs.mkdirSync(DUMP, { recursive: true });
  fs.writeFileSync(path.join(DUMP, `${name}.json`), JSON.stringify(body, null, 2));
}

// Types attendus par les modèles Dart (lib/calculation_notes/model).
const isInt = (v) => Number.isInteger(v);
const isStrOrNull = (v) => v === null || typeof v === "string";
const isUserOrNull = (u) => u === null || (u && typeof u.id === "string" && typeof u.email === "string" && typeof u.name === "string");

function checkPage(body, label) {
  expect(Array.isArray(body.data)).toBe(true);
  for (const k of ["page", "limit", "total", "totalPages"]) expect([label, k, isInt(body.pagination[k])]).toEqual([label, k, true]);
  // Indicateurs : nombres ; byCreator : tableau [{ user, count }].
  for (const k of ["total", "thisMonth", "documents", "mine", "EN_ATTENTE_VALIDATION", "VALIDEE", "REFUSEE", "ANNULEE"]) {
    expect([label, k, isInt(body.summary[k])]).toEqual([label, k, true]);
  }
  expect(Array.isArray(body.summary.byCreator)).toBe(true);
  for (const c of body.summary.byCreator) expect(isUserOrNull(c.user) && isInt(c.count)).toBe(true);
  for (const n of body.data) {
    expect(isInt(n.id) && typeof n.reference === "string" && isInt(n.documentsCount) && isInt(n.submissionVersion)).toBe(true);
    expect(typeof n.status === "string" && typeof n.canEdit === "boolean" && typeof n.canDecide === "boolean").toBe(true);
    expect(isStrOrNull(n.commentaire) && isUserOrNull(n.creator) && isUserOrNull(n.requester) && isUserOrNull(n.assignedTo)).toBe(true);
  }
}

function checkDetail(d) {
  expect(isInt(d.id) && isInt(d.submissionVersion) && typeof d.status === "string").toBe(true);
  expect(Array.isArray(d.documents) && Array.isArray(d.history)).toBe(true);
  for (const doc of d.documents) {
    expect(typeof doc.id === "string" && isInt(doc.noteId) && isInt(doc.sizeBytes) && typeof doc.originalName === "string" && typeof doc.origin === "string").toBe(true);
  }
  for (const h of d.history) expect(typeof h.action === "string" && (h.details === null || typeof h.details === "object")).toBe(true);
  for (const k of ["canEdit", "canDecide", "canCancel", "canAssign", "canAddComplementary", "canResubmit", "canManageNotifications"]) expect(typeof d[k]).toBe("boolean");
}

beforeAll(async () => {
  [C, R, V] = await Promise.all([account("dhouib.maissa@esprit.tn"), account("info@probardistribution.com"), account("medwethekgc@gmail.com")]);
  _resetCache();
  if (PASSWORD) {
    const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
    BO = { Authorization: `Bearer ${res.body.accessToken}` };
  }
  [PROJECT] = await sql(`SELECT id FROM projects WHERE "ownerId" = :c AND COALESCE("isArchived", false) = false ORDER BY "createdAt" LIMIT 1`, { c: C.user.id });
  const [c] = await sql(`SELECT "lastValue" FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  counterBefore = c ? c.lastValue : null;

  const DOCX = await ooxml();
  notes.sansDocument = await create();
  notes.plusieursDocuments = await create([[PDF, "calcul.pdf"], [DOCX, "hypotheses.docx"], [PDF, "plan.pdf"]]);
  notes.validee = await create([[PDF, "v.pdf"]]);
  notes.refusee = await create();
  notes.annulee = await create();
  await request(app).post(`/calculation-notes/${notes.validee.id}/validate`).set(V.auth).send({});
  await request(app).post(`/calculation-notes/${notes.refusee.id}/reject`).set(V.auth).send({ commentaire: "Plans manquants" });
  await request(app).post(`/calculation-notes/${notes.annulee.id}/cancel`).set(C.auth).send({ motif: "Doublon" });
});

afterAll(async () => {
  await purgeCalculationNotes(sql, createdIds);
  if (counterBefore === null) await sql(`DELETE FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  else await sql(`UPDATE calculation_note_counters SET "lastValue" = :v WHERE year = :y`, { v: counterBefore, y: YEAR });
  fs.rmSync(STORAGE, { recursive: true, force: true });
  await sequelize.close();
});

describe("Contrat JSON de l'API Notes de calcul", () => {
  const accounts = () => [
    ["createur", C.auth],
    ["wethek", V.auth],
    ...(BO ? [["backoffice", BO]] : []),
  ];

  test("liste, file de validation, statistiques : nombres pour les compteurs, tableau pour byCreator", async () => {
    for (const [who, auth] of accounts()) {
      for (const [name, url] of [
        ["liste", "/calculation-notes?limit=100"],
        ["liste-en-attente", "/calculation-notes?status=EN_ATTENTE_VALIDATION&limit=100"],
        ["liste-validees", "/calculation-notes?status=VALIDEE&limit=100"],
        ["liste-refusees", "/calculation-notes?status=REFUSEE&limit=100"],
        ["liste-annulees", "/calculation-notes?status=ANNULEE&limit=100"],
      ]) {
        const res = await request(app).get(url).set(auth);
        expect([who, name, res.status]).toEqual([who, name, 200]);
        checkPage(res.body, `${who}/${name}`);
        dump(`${who}-${name}`, res.body);
      }
      const q = await request(app).get("/calculation-notes/validation?limit=100").set(auth);
      if (who === "createur") {
        expect(q.status).toBe(403); // rubrique réservée (droit inchangé)
      } else {
        checkPage(q.body, `${who}/validation`);
        dump(`${who}-validation`, q.body);
      }
    }
  });

  test("détail des 6 cas (sans document, plusieurs documents, en attente, validée, refusée, annulée) pour les 3 comptes", async () => {
    for (const [who, auth] of accounts()) {
      for (const [name, n] of Object.entries(notes)) {
        const res = await request(app).get(`/calculation-notes/${n.id}`).set(auth);
        expect([who, name, res.status]).toEqual([who, name, 200]);
        checkDetail(res.body.data);
        dump(`${who}-detail-${name}`, res.body);
      }
    }
    // Comptages de documents réels.
    const multi = (await request(app).get(`/calculation-notes/${notes.plusieursDocuments.id}`).set(C.auth)).body.data;
    expect(multi.documents).toHaveLength(3);
    expect((await request(app).get(`/calculation-notes/${notes.sansDocument.id}`).set(C.auth)).body.data.documents).toEqual([]);
  });

  test("statistiques cohérentes avec la base pour chaque compte (aucun compteur en dur)", async () => {
    for (const [who, auth] of accounts()) {
      const res = await request(app).get("/calculation-notes?limit=100").set(auth);
      const ids = res.body.data.map((n) => n.id);
      const rows = ids.length ? await sql(`SELECT status, (SELECT COUNT(*)::int FROM calculation_note_documents d WHERE d."noteId" = n.id) docs FROM calculation_notes n WHERE id IN (:ids)`, { ids }) : [];
      const count = (st) => rows.filter((r) => r.status === st).length;
      const s = res.body.summary;
      expect([who, s.total, s.EN_ATTENTE_VALIDATION, s.VALIDEE, s.REFUSEE, s.ANNULEE, s.documents]).toEqual([
        who,
        rows.length,
        count("EN_ATTENTE_VALIDATION"),
        count("VALIDEE"),
        count("REFUSEE"),
        count("ANNULEE"),
        rows.reduce((a, r) => a + r.docs, 0),
      ]);
      expect(s.byCreator.reduce((a, c) => a + c.count, 0)).toBe(s.total);
    }
  });

  test("options et permissions : types attendus", async () => {
    for (const [who, auth] of accounts()) {
      const p = await request(app).get("/calculation-notes/permissions").set(auth);
      expect(typeof p.body.data.isValidator === "boolean" && isInt(p.body.data.pendingToValidate)).toBe(true);
      dump(`${who}-permissions`, p.body);
      const o = await request(app).get("/calculation-notes/options").set(auth);
      expect(Array.isArray(o.body.data.projects) && Array.isArray(o.body.data.requesters) && Array.isArray(o.body.data.assignees)).toBe(true);
      expect(typeof o.body.data.assigneeRequired).toBe("boolean");
      dump(`${who}-options`, o.body);
    }
  });
});
