"use strict";

// Module « Notes de calcul » — /calculation-notes, contre la base de
// DÉVELOPPEMENT locale (jamais la production).
// Comptes et projets RÉELS ; les notes créées par ce test sont retirées à la
// fin et le compteur annuel est remis à sa valeur d'origine, pour laisser la
// base de développement exactement dans l'état initial. Fichiers écrits dans
// un dossier temporaire dédié (CALCULATION_NOTES_STORAGE_DIR).

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "nc-test-"));
process.env.CALCULATION_NOTES_STORAGE_DIR = STORAGE;
process.env.CALCULATION_NOTE_MAX_FILE_MB = "1";

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
const PDFDocument = require("pdfkit");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const { tunisYear } = require("../src/modules/calculation-notes/services/calculationNote.service");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");
const { purgeCalculationNotes } = require("./helpers/calculationNotes");

const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const YEAR = tunisYear();
const createdIds = [];
let counterBefore;

async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte de test absent : ${email}`);
  return { user: u, auth: { Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` } };
}

function pdfBuffer(text) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.text(text);
    doc.end();
  });
}

async function ooxml(kind, { macro = false } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  if (kind === "docx") zip.file("word/document.xml", "<w:document/>");
  else zip.file("xl/workbook.xml", "<workbook/>");
  if (macro) zip.file(`${kind === "docx" ? "word" : "xl"}/vbaProject.bin`, "macro");
  return zip.generateAsync({ type: "nodebuffer" });
}

// Supertest : récupère le corps binaire d'une réponse.
const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

let A; // propriétaire du projet (rôle user)
let B; // autre utilisateur CRM, sans accès au projet
let ADMIN;
let REF; // compte de référence du back-office (commercial)
let BACKOFFICE;
let PROJECT; // projet de A
let PDF;
let DOCX;
let XLSX;

beforeAll(async () => {
  [A, B, ADMIN, REF] = await Promise.all([
    account("medwethekgc@gmail.com"),
    account("mouemensfax@gmail.com"),
    account("cbitunisia@cbi-tunisia.com"),
    account("info@probardistribution.com"),
  ]);
  const [bo] = await sql(`SELECT id, email, role FROM users WHERE email = 'backoffice@cbi-tunisia.com'`);
  BACKOFFICE = bo ? { Authorization: `Bearer ${signAccessToken({ sub: bo.id, email: bo.email, role: bo.role })}` } : null;
  _resetCache();
  [PROJECT] = await sql(
    `SELECT p.id, p."nomProjet" FROM projects p
      WHERE p."ownerId" = :a AND COALESCE(p."isArchived", false) = false
        AND NOT EXISTS (SELECT 1 FROM user_projects up WHERE up."projectId" = p.id AND up."userId" = :b)
        AND p."ownerId" <> :b
      ORDER BY p."createdAt" LIMIT 1`,
    { a: A.user.id, b: B.user.id }
  );
  const [c] = await sql(`SELECT "lastValue" FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  counterBefore = c ? c.lastValue : null;
  PDF = await pdfBuffer("Note de calcul — dalle PROBAR");
  DOCX = await ooxml("docx");
  XLSX = await ooxml("xlsx");
});

afterAll(async () => {
  // Uniquement les lignes créées par ce test.
  await purgeCalculationNotes(sql, createdIds);
  if (counterBefore === null) await sql(`DELETE FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  else await sql(`UPDATE calculation_note_counters SET "lastValue" = :v WHERE year = :y`, { v: counterBefore, y: YEAR });
  fs.rmSync(STORAGE, { recursive: true, force: true });
  await sequelize.close();
});

function createNote(auth, { projectId = PROJECT.id, requesterId, commentaire, files = [], comments, titles, types } = {}) {
  const r = request(app).post("/calculation-notes").set(auth).field("projectId", projectId).field("requesterId", requesterId);
  if (commentaire !== undefined) r.field("commentaire", commentaire);
  if (comments) r.field("commentaires", JSON.stringify(comments));
  if (titles) r.field("titres", JSON.stringify(titles));
  if (types) r.field("types", JSON.stringify(types));
  for (const [buf, name] of files) r.attach("files", buf, name);
  return r.then((res) => {
    if (res.status === 201) createdIds.push(res.body.data.id);
    return res;
  });
}

const REF_RE = new RegExp(`^NC-${YEAR}-\\d{4,}$`);

describe("Notes de calcul", () => {
  test("listes déroulantes : projets accessibles en écriture et demandeurs = utilisateurs CRM actifs", async () => {
    expect(PROJECT).toBeTruthy();
    const res = await request(app).get("/calculation-notes/options").set(A.auth);
    expect(res.status).toBe(200);
    const [{ n }] = await sql(
      `SELECT COUNT(*)::int n FROM projects p WHERE COALESCE(p."isArchived", false) = false AND (p."ownerId" = :a
         OR p.id IN (SELECT "projectId" FROM user_projects WHERE "userId" = :a AND permission IN ('owner','editor')))`,
      { a: A.user.id }
    );
    expect(res.body.data.projects).toHaveLength(Math.min(n, 500));
    expect(res.body.data.projects.map((p) => p.id)).toContain(PROJECT.id);
    const [{ u }] = await sql(`SELECT COUNT(*)::int u FROM users WHERE "isActive" AND role IN ('user','commercial','accueil','admin','superadmin','superadmin2')`);
    expect(res.body.data.requesters).toHaveLength(u);
    expect(res.body.data.requesters.map((r) => r.email)).not.toContain("backoffice@cbi-tunisia.com");
    // B n'a pas ce projet dans ses choix.
    const resB = await request(app).get("/calculation-notes/options").set(B.auth);
    expect(resB.body.data.projects.map((p) => p.id)).not.toContain(PROJECT.id);
  });

  let noteFromProject;

  test("création depuis un projet : PDF + DOCX, commentaires distincts, référence automatique, historique", async () => {
    const res = await createNote(A.auth, {
      requesterId: REF.user.id,
      commentaire: "Observations générales",
      files: [[PDF, "Note de calcul dalle é.pdf"], [DOCX, "Hypothèses.docx"]],
      comments: ["Calcul principal", "Hypothèses de charge"],
      titles: ["Calcul dalle niveau R+1", "Hypothèses de charge"],
      types: ["note_de_calcul", "hypotheses"],
    });
    expect(res.status).toBe(201);
    const n = res.body.data;
    noteFromProject = n;
    expect(n.reference).toMatch(REF_RE);
    expect(n.project).toMatchObject({ id: PROJECT.id, nomProjet: PROJECT.nomProjet });
    expect(n.requester.id).toBe(REF.user.id);
    expect(n.creator.id).toBe(A.user.id);
    expect(n.canEdit).toBe(true);
    expect(n.documents.map((d) => [d.originalName, d.extension, d.commentaire, d.sizeBytes])).toEqual([
      ["Note de calcul dalle é.pdf", "pdf", "Calcul principal", PDF.length],
      ["Hypothèses.docx", "docx", "Hypothèses de charge", DOCX.length],
    ]);
    expect(n.documents[0].mimeType).toBe("application/pdf");
    // Nom et type saisis par document.
    expect(n.documents.map((d) => [d.title, d.documentType])).toEqual([
      ["Calcul dalle niveau R+1", "note_de_calcul"],
      ["Hypothèses de charge", "hypotheses"],
    ]);
    expect(n.history.map((h) => h.action).sort()).toEqual(["DOCUMENT_ADDED", "DOCUMENT_ADDED", "NOTE_CREATED", "NOTE_SUBMITTED"]);
    expect(n.status).toBe("EN_ATTENTE_VALIDATION");
    // En base : lien note ↔ projet sur chaque document, nom de fichier généré.
    const rows = await sql(`SELECT "projectId", "storedFileName", sha256, "uploadedBy" FROM calculation_note_documents WHERE "noteId" = :id`, { id: n.id });
    for (const r of rows) {
      expect(r.projectId).toBe(PROJECT.id);
      expect(r.uploadedBy).toBe(A.user.id);
      expect(r.storedFileName).toMatch(/^nc-[0-9a-f-]{36}\.(pdf|docx)$/);
      expect(fs.existsSync(path.join(STORAGE, r.storedFileName))).toBe(true);
    }
    expect(rows.map((r) => r.sha256).sort()).toEqual([PDF, DOCX].map((b) => crypto.createHash("sha256").update(b).digest("hex")).sort());
  });

  test("projet créé depuis le formulaire de note (API Projets existante) : propriétaire, proposé, note liée par son ID", async () => {
    const LINKED = ["projects", "user_projects", "project_actions", "project_reminders", "project_activities", "notifications", "companies", "engineers", "architects"];
    const counts = async () => Object.fromEntries(await Promise.all(LINKED.map(async (t) => [t, (await sql(`SELECT COUNT(*)::int n FROM ${t}`))[0].n])));
    const before = await counts();
    const nom = `Projet test note de calcul ${Date.now()}`;
    // Mêmes règles que le module Projets : champs obligatoires refusés…
    const invalid = await request(app).post("/projects").set(B.auth).send({ nomProjet: nom, projectModele: "project" });
    expect(invalid.status).toBe(400);
    // …puis création réelle par l'API existante (aucun second système).
    const created = await request(app)
      .post("/projects")
      .set(B.auth)
      .send({ nomProjet: nom, projectModele: "project", dateDemarrage: "2026-10-30", typeAdresseChantier: "Villa", firstAction: "Visite", dateVisite: "2026-10-30", location: { lat: 36.8065, lng: 10.1815 } });
    expect(created.status).toBe(201);
    const projectId = created.body.id;
    try {
      expect(created.body).toMatchObject({ nomProjet: nom, ownerId: B.user.id, permission: "owner" });
      const options = await request(app).get("/calculation-notes/options").set(B.auth);
      expect(options.body.data.projects.find((p) => p.id === projectId)).toMatchObject({ nomProjet: nom });
      // Le même nom est refusé (règle de doublon du module Projets).
      expect((await request(app).post("/projects").set(B.auth).send({ nomProjet: nom, projectModele: "project", dateDemarrage: "2026-10-30", typeAdresseChantier: "Villa", firstAction: "Visite", dateVisite: "2026-10-30", location: { lat: 36.8, lng: 10.1 } })).status).toBe(409);
      const note = await createNote(B.auth, { projectId, requesterId: REF.user.id, commentaire: "Saisi avant la création du projet", files: [[PDF, "calcul.pdf"]], comments: ["Calcul"] });
      expect(note.status).toBe(201);
      expect(note.body.data).toMatchObject({ project: { id: projectId, nomProjet: nom }, requester: { id: REF.user.id }, creator: { id: B.user.id }, commentaire: "Saisi avant la création du projet" });
      const [row] = await sql(`SELECT "projectId", "requesterId", "createdBy" FROM calculation_notes WHERE id = :id`, { id: note.body.data.id });
      expect(row).toEqual({ projectId, requesterId: REF.user.id, createdBy: B.user.id });
      // Un utilisateur sans lien avec ce projet (ni validateur) ne voit pas la note.
      const outsider = await account("dhouib.maissa@esprit.tn");
      expect((await request(app).get(`/calculation-notes/${note.body.data.id}`).set(outsider.auth)).status).toBe(404);
    } finally {
      // Retire uniquement ce que ce test a créé (note, projet et ses liens).
      const ids = (await sql(`SELECT id FROM calculation_notes WHERE "projectId" = :projectId`, { projectId })).map((r) => r.id);
      if (ids.length) {
        await purgeCalculationNotes(sql, ids);
        createdIds.splice(0, createdIds.length, ...createdIds.filter((id) => !ids.includes(id)));
      }
      await sql(`DELETE FROM project_reminders WHERE "projectId" = :projectId`, { projectId });
      for (const t of ["notifications", "project_activities", "project_actions", "user_projects"]) await sql(`DELETE FROM ${t} WHERE "projectId" = :projectId`, { projectId });
      await sql(`DELETE FROM projects WHERE id = :projectId`, { projectId });
    }
    expect(await counts()).toEqual(before);
  }, 60000); // création de projet réelle (synchronisations du module Projets)

  test("création depuis le menu sans document (ajout ultérieur possible), puis ajout d'un XLSX", async () => {
    const res = await createNote(A.auth, { requesterId: A.user.id });
    expect(res.status).toBe(201);
    expect(res.body.data.documents).toEqual([]);
    const add = await request(app).post(`/calculation-notes/${res.body.data.id}/documents`).set(A.auth).field("commentaires", JSON.stringify(["Métré"])).attach("files", XLSX, "metre.xlsx");
    expect(add.status).toBe(201);
    expect(add.body.data.documents.map((d) => [d.originalName, d.commentaire])).toEqual([["metre.xlsx", "Métré"]]);
  });

  test("références séquentielles et uniques, y compris en création simultanée", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => createNote(A.auth, { requesterId: A.user.id })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const refs = results.map((r) => r.body.data.reference);
    expect(new Set(refs).size).toBe(8);
    const nums = refs.map((r) => Number(r.split("-")[2])).sort((a, b) => a - b);
    expect(nums[7] - nums[0]).toBe(7); // aucun trou, aucun doublon
    const [{ dup }] = await sql(`SELECT COUNT(*)::int dup FROM (SELECT reference FROM calculation_notes GROUP BY reference HAVING COUNT(*) > 1) x`);
    expect(dup).toBe(0);
    // Un numéro n'est jamais réutilisé : le compteur ne redescend pas.
    const [{ lastValue }] = await sql(`SELECT "lastValue" FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
    expect(lastValue).toBe(nums[7]);
  });

  test("uploads refusés : contenu falsifié, format interdit, macros, taille, demandeur/projet invalides", async () => {
    const fake = await createNote(A.auth, { requesterId: A.user.id, files: [[Buffer.from("MZ pas un pdf"), "note.pdf"]] });
    expect([fake.status, fake.body.code]).toEqual([400, "FILE_CONTENT_MISMATCH"]);
    const exe = await createNote(A.auth, { requesterId: A.user.id, files: [[Buffer.from("MZ"), "outil.exe"]] });
    expect([exe.status, exe.body.code]).toEqual([400, "FILE_TYPE_NOT_ALLOWED"]);
    const macro = await createNote(A.auth, { requesterId: A.user.id, files: [[await ooxml("docx", { macro: true }), "m.docx"]] });
    expect([macro.status, macro.body.code]).toEqual([400, "FILE_MACRO_NOT_ALLOWED"]);
    const big = await createNote(A.auth, { requesterId: A.user.id, files: [[Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 1)]), "gros.pdf"]] });
    expect([big.status, big.body.code]).toEqual([413, "FILE_TOO_LARGE"]);
    const badType = await createNote(A.auth, { requesterId: A.user.id, files: [[PDF, "a.pdf"]], types: ["virus"] });
    expect([badType.status, badType.body.code]).toEqual([400, "INVALID_DOCUMENT_TYPE"]);
    const req = await createNote(A.auth, { requesterId: crypto.randomUUID() });
    expect([req.status, req.body.code]).toEqual([400, "REQUESTER_INVALID"]);
    const [industrial] = await sql(`SELECT id FROM users WHERE role = 'responsable_logistique_achat' LIMIT 1`);
    const req2 = await createNote(A.auth, { requesterId: industrial.id });
    expect(req2.body.code).toBe("REQUESTER_INVALID");
    const proj = await createNote(A.auth, { projectId: "not-a-uuid", requesterId: A.user.id });
    expect([proj.status, proj.body.code]).toEqual([400, "PROJECT_REQUIRED"]);
    // Nom d'origine avec chemin : nettoyé, jamais utilisé comme chemin.
    const trav = await createNote(A.auth, { requesterId: A.user.id, files: [[PDF, "../../evil.pdf"]] });
    expect(trav.status).toBe(201);
    expect(trav.body.data.documents[0].originalName).not.toMatch(/[\\/]/);
    expect(fs.readdirSync(STORAGE).every((f) => /^nc-[0-9a-f-]{36}\./.test(f))).toBe(true);
  });

  test("consultation et téléchargement : octets identiques, en-têtes sûrs, aperçu PDF", async () => {
    const [pdfDoc, docxDoc] = noteFromProject.documents;
    const dl = await request(app).get(`/calculation-notes/${noteFromProject.id}/documents/${pdfDoc.id}/download`).set(A.auth).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body, PDF)).toBe(0);
    expect(dl.headers["content-type"]).toBe("application/pdf");
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename=".+"; filename\*=UTF-8''Note%20de%20calcul%20dalle%20%C3%A9\.pdf$/);
    expect(dl.headers["cache-control"]).toBe("private, no-store");
    const inline = await request(app).get(`/calculation-notes/${noteFromProject.id}/documents/${pdfDoc.id}/download?inline=1`).set(A.auth).buffer(true).parse(binary);
    expect(inline.headers["content-disposition"]).toMatch(/^inline;/);
    // Word : toujours en pièce jointe.
    const word = await request(app).get(`/calculation-notes/${noteFromProject.id}/documents/${docxDoc.id}/download?inline=1`).set(A.auth).buffer(true).parse(binary);
    expect(Buffer.compare(word.body, DOCX)).toBe(0);
    expect(word.headers["content-disposition"]).toMatch(/^attachment;/);
    // Jamais servi par le dossier public /uploads.
    const [{ storedFileName }] = await sql(`SELECT "storedFileName" FROM calculation_note_documents WHERE id = :id`, { id: pdfDoc.id });
    expect((await request(app).get(`/uploads/${storedFileName}`)).status).toBe(404);
    expect((await request(app).get(`/calculation-notes/${noteFromProject.id}/documents/${pdfDoc.id}/download`)).status).toBe(401);
  });

  test("modification autorisée : demandeur, observations, commentaire de document — historique conservé", async () => {
    const id = noteFromProject.id;
    const upd = await request(app).patch(`/calculation-notes/${id}`).set(A.auth).send({ requesterId: A.user.id, commentaire: "Observations révisées" });
    expect(upd.status).toBe(200);
    expect(upd.body.data.requester.id).toBe(A.user.id);
    const docId = noteFromProject.documents[1].id;
    const dc = await request(app).patch(`/calculation-notes/${id}/documents/${docId}`).set(A.auth).send({ commentaire: "Hypothèses v2" });
    expect(dc.body.data.documents[1].commentaire).toBe("Hypothèses v2");
    const h = await request(app).get(`/calculation-notes/${id}/history`).set(A.auth);
    const actions = h.body.data.map((x) => x.action);
    expect(actions.slice(0, 2)).toEqual(["DOCUMENT_COMMENT_UPDATED", "NOTE_UPDATED"]);
    expect(h.body.data[1].details.changes).toEqual({
      requesterId: { from: REF.user.id, to: A.user.id },
      commentaire: { from: "Observations générales", to: "Observations révisées" },
    });
    expect(h.body.data[0].details).toMatchObject({ from: "Hypothèses de charge", to: "Hypothèses v2" });
    // Nom et type modifiables, historisés.
    const ren = await request(app).patch(`/calculation-notes/${id}/documents/${docId}`).set(A.auth).send({ title: "Hypothèses v2", documentType: "annexe" });
    expect(ren.body.data.documents[1]).toMatchObject({ title: "Hypothèses v2", documentType: "annexe", commentaire: "Hypothèses v2" });
    const h2 = await request(app).get(`/calculation-notes/${id}/history`).set(A.auth);
    expect(h2.body.data[0]).toMatchObject({ action: "DOCUMENT_UPDATED", details: { changes: { title: { from: "Hypothèses de charge", to: "Hypothèses v2" }, documentType: { from: "hypotheses", to: "annexe" } } } });
    // Le projet et la référence ne sont pas modifiables.
    const other = await request(app).patch(`/calculation-notes/${id}`).set(A.auth).send({ projectId: crypto.randomUUID(), reference: "NC-1999-0001" });
    expect(other.body.data).toMatchObject({ reference: noteFromProject.reference, project: { id: PROJECT.id } });
  });

  test("permissions : sans accès au projet → note invisible, aucune écriture ; admin voit tout", async () => {
    const id = noteFromProject.id;
    const docId = noteFromProject.documents[0].id;
    expect((await request(app).get(`/calculation-notes/${id}`).set(B.auth)).status).toBe(404);
    expect((await request(app).get(`/calculation-notes/${id}/documents/${docId}/download`).set(B.auth)).status).toBe(404);
    expect((await request(app).patch(`/calculation-notes/${id}`).set(B.auth).send({ commentaire: "x" })).status).toBe(404);
    expect((await request(app).post(`/calculation-notes/${id}/documents`).set(B.auth).attach("files", PDF, "x.pdf")).status).toBe(404);
    const create = await createNote(B.auth, { requesterId: B.user.id });
    expect([create.status, create.body.code]).toEqual([403, "PERMISSION_DENIED"]);
    const listB = await request(app).get(`/calculation-notes?limit=100&projectId=${PROJECT.id}`).set(B.auth);
    expect(listB.body.data.map((n) => n.id)).not.toContain(id);
    // Admin : lecture et modification.
    const adm = await request(app).get(`/calculation-notes/${id}`).set(ADMIN.auth);
    expect([adm.status, adm.body.data.canEdit]).toEqual([200, true]);
    // Demandeur sans droit sur le projet : lecture seule (canEdit = false).
    const asReq = await createNote(A.auth, { requesterId: B.user.id });
    const seen = await request(app).get(`/calculation-notes/${asReq.body.data.id}`).set(B.auth);
    expect([seen.status, seen.body.data.canEdit]).toEqual([200, false]);
    const denied = await request(app).patch(`/calculation-notes/${asReq.body.data.id}`).set(B.auth).send({ commentaire: "x" });
    expect([denied.status, denied.body.code]).toEqual([403, "PERMISSION_DENIED"]);
    // Rôles hors CRM : module refusé.
    for (const email of ["production_1@cbi-tunisia.com", "controle_qualite@cbi-tunisia.com"]) {
      const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
      if (!u) continue;
      const t = { Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` };
      expect((await request(app).get(`/calculation-notes`).set(t)).status).toBe(403);
    }
  });

  test("liste : recherche référence / projet, filtres demandeur et période, tri, pagination, indicateurs", async () => {
    const ref = noteFromProject.reference;
    const byRef = await request(app).get(`/calculation-notes?reference=${ref}`).set(A.auth);
    expect(byRef.body.data.map((n) => n.reference)).toEqual([ref]);
    expect(byRef.body.data[0]).toMatchObject({ documentsCount: 2, commentaire: "Observations révisées", canEdit: true, project: { nomProjet: PROJECT.nomProjet } });
    // canEdit de la liste = canEdit du détail (demandeur sans droit : false).
    const forB = await request(app).get(`/calculation-notes?requesterId=${B.user.id}`).set(B.auth);
    expect(forB.body.data.every((n) => n.canEdit === false)).toBe(true);
    const byProject = await request(app).get(`/calculation-notes?project=${encodeURIComponent(PROJECT.nomProjet)}&limit=100`).set(A.auth);
    expect(byProject.body.data.map((n) => n.id)).toEqual(expect.arrayContaining(createdIds.slice(0, 2)));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis" }).format(new Date());
    const byReq = await request(app).get(`/calculation-notes?requesterId=${B.user.id}&from=${today}&to=${today}`).set(A.auth);
    expect(byReq.body.data.every((n) => n.requester.id === B.user.id)).toBe(true);
    expect(byReq.body.data.length).toBe(1);
    const past = await request(app).get(`/calculation-notes?to=2000-01-01`).set(A.auth);
    expect(past.body.data).toEqual([]);
    const asc = await request(app).get(`/calculation-notes?sortBy=reference&sortDir=asc&limit=100`).set(ADMIN.auth);
    const nums = asc.body.data.map((n) => Number(n.reference.split("-")[2]) + Number(n.reference.split("-")[1]) * 1e6);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    const p1 = await request(app).get(`/calculation-notes?limit=3&page=1`).set(A.auth);
    const p2 = await request(app).get(`/calculation-notes?limit=3&page=2`).set(A.auth);
    expect(p1.body.pagination).toMatchObject({ page: 1, limit: 3 });
    expect(p1.body.data.map((n) => n.id)).not.toEqual(expect.arrayContaining(p2.body.data.map((n) => n.id)));
    const [{ total }] = await sql(`SELECT COUNT(*)::int total FROM calculation_notes`);
    const admList = await request(app).get(`/calculation-notes?limit=1`).set(ADMIN.auth);
    expect(admList.body.summary.total).toBe(total);
    expect(admList.body.pagination.total).toBe(total);
  });

  test("back-office : vue globale (toutes les notes, comme un admin), aucune écriture hors décision (403)", async () => {
    if (!BACKOFFICE) return;
    const mine = await request(app).get(`/calculation-notes?limit=100`).set(BACKOFFICE);
    const adm = await request(app).get(`/calculation-notes?limit=100`).set(ADMIN.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((n) => n.id)).toEqual(adm.body.data.map((n) => n.id));
    const [{ total }] = await sql(`SELECT COUNT(*)::int total FROM calculation_notes`);
    expect(mine.body.summary.total).toBe(total);
    // Toutes les notes de test, quel que soit le créateur / demandeur.
    for (const n of createdIds) {
      const det = await request(app).get(`/calculation-notes/${n}`).set(BACKOFFICE);
      expect([det.status, det.body.data.canEdit]).toEqual([200, false]);
    }
    const docId = noteFromProject.documents[0].id;
    const dl = await request(app).get(`/calculation-notes/${noteFromProject.id}/documents/${docId}/download`).set(BACKOFFICE).buffer(true).parse(binary);
    expect([dl.status, Buffer.compare(dl.body, PDF)]).toEqual([200, 0]);
    const before = await sql(`SELECT COUNT(*)::int n FROM calculation_notes`);
    for (const r of [
      request(app).post("/calculation-notes").set(BACKOFFICE).field("projectId", PROJECT.id).field("requesterId", REF.user.id),
      request(app).patch(`/calculation-notes/${noteFromProject.id}`).set(BACKOFFICE).send({ commentaire: "x" }),
      request(app).post(`/calculation-notes/${noteFromProject.id}/documents`).set(BACKOFFICE).attach("files", PDF, "x.pdf"),
      request(app).patch(`/calculation-notes/${noteFromProject.id}/documents/${docId}`).set(BACKOFFICE).send({ commentaire: "x" }),
    ]) {
      const res = await r;
      expect([res.status, res.body.code]).toEqual([403, "READ_ONLY_ACCOUNT"]);
    }
    expect(await sql(`SELECT COUNT(*)::int n FROM calculation_notes`)).toEqual(before);
  });

  test("conservation après actualisation et reconnexion : documents toujours présents et téléchargeables", async () => {
    // Nouveau jeton (reconnexion) et relecture complète depuis la base.
    const again = { Authorization: `Bearer ${signAccessToken({ sub: A.user.id, email: A.user.email, role: A.user.role })}` };
    const res = await request(app).get(`/calculation-notes/${noteFromProject.id}`).set(again);
    expect(res.body.data.documents.map((d) => d.originalName)).toEqual(["Note de calcul dalle é.pdf", "Hypothèses.docx"]);
    for (const d of res.body.data.documents) {
      const dl = await request(app).get(`/calculation-notes/${noteFromProject.id}/documents/${d.id}/download`).set(again).buffer(true).parse(binary);
      expect([dl.status, dl.body.length]).toEqual([200, d.sizeBytes]);
    }
  });
});
