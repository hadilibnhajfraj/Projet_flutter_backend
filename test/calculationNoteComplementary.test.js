"use strict";

// Documents complémentaires de l'utilisateur affecté — contre la base de
// DÉVELOPPEMENT locale (jamais la production). Comptes et projets réels :
//   créateur    dhouib.maissa@esprit.tn (sur l'un de ses projets actifs)
//   demandeur   info@probardistribution.com
//   affecté     faycelmarzouk@probardistribution.com (puis hadil.ibnhajfraj@gmail.com)
//   validateur  medwethekgc@gmail.com
// Envoi SMTP simulé. Tout ce que le test crée est retiré à la fin ; le
// compteur annuel est remis à sa valeur d'origine.

const os = require("os");
const fs = require("fs");
const path = require("path");

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "nc-complementary-"));
process.env.CALCULATION_NOTES_STORAGE_DIR = STORAGE;

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
const { flushNotifications } = require("../src/modules/calculation-notes/services/calculationNoteNotify.service");
const { resolveFullName } = require("../src/utils/userDisplay");
const { User, UserProfile } = require("../src/models/associations");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");
const { purgeCalculationNotes } = require("./helpers/calculationNotes");

const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const YEAR = tunisYear();
const pdf = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const createdIds = [];
const names = {};
let counterBefore;
let C;
let R;
let A;
let A2;
let V;
let O;
let ADMIN;
let BACKOFFICE;
let PROJECT;
let DOCX;
let XLSX;

const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });
async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte de test absent : ${email}`);
  names[u.id] = resolveFullName(await User.findByPk(u.id, { include: [{ model: UserProfile, as: "profile", required: false }] }));
  return { user: u, auth: tokenFor(u) };
}

async function ooxml(kind) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types/>`);
  zip.file(kind === "docx" ? "word/document.xml" : "xl/workbook.xml", "<x/>");
  return zip.generateAsync({ type: "nodebuffer" });
}

const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

function upload(path_, auth, files, { types, comments } = {}) {
  const r = request(app).post(path_).set(auth);
  if (types) r.field("types", JSON.stringify(types));
  if (comments) r.field("commentaires", JSON.stringify(comments));
  for (const [buf, name] of files) r.attach("files", buf, name);
  return r;
}

async function createNote(assigneeId, files = [], meta = {}) {
  const r = request(app).post("/calculation-notes").set(C.auth).field("projectId", PROJECT.id).field("requesterId", R.user.id).field("commentaire", "Dalle R+1").field("assignedToUserId", assigneeId);
  if (meta.types) r.field("types", JSON.stringify(meta.types));
  if (meta.comments) r.field("commentaires", JSON.stringify(meta.comments));
  for (const [buf, name] of files) r.attach("files", buf, name);
  const res = await r;
  if (res.status === 201) createdIds.push(res.body.data.id);
  return res;
}

const notificationsOf = (noteId, type) =>
  sql(`SELECT "userId", "calculationNoteVersion" FROM notifications WHERE "calculationNoteId" = :noteId AND type = :type ORDER BY "createdAt"`, { noteId, type });
const emailsOf = (noteId, type) =>
  sql(`SELECT "to", subject, text, status::text AS status FROM email_queue WHERE context = 'calculation-note-validation' AND (meta->>'calculationNoteId')::int = :noteId AND meta->>'type' = :type ORDER BY "createdAt"`, { noteId, type });

beforeAll(async () => {
  [C, R, A, A2, V, O, ADMIN] = await Promise.all([
    account("dhouib.maissa@esprit.tn"),
    account("info@probardistribution.com"),
    account("faycelmarzouk@probardistribution.com"),
    account("hadil.ibnhajfraj@gmail.com"),
    account("medwethekgc@gmail.com"),
    account("mouemensfax@gmail.com"),
    account("cbitunisia@cbi-tunisia.com"),
  ]);
  const [bo] = await sql(`SELECT id, email, role FROM users WHERE email = 'backoffice@cbi-tunisia.com'`);
  BACKOFFICE = bo ? tokenFor(bo) : null;
  _resetCache();
  [PROJECT] = await sql(
    `SELECT id, "nomProjet" FROM projects p WHERE p."ownerId" = :c AND COALESCE(p."isArchived", false) = false
       AND NOT EXISTS (SELECT 1 FROM user_projects up WHERE up."projectId" = p.id AND up."userId" IN (:others))
     ORDER BY "createdAt" LIMIT 1`,
    { c: C.user.id, others: [A.user.id, A2.user.id, V.user.id, O.user.id] }
  );
  const [c] = await sql(`SELECT "lastValue" FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  counterBefore = c ? c.lastValue : null;
  DOCX = await ooxml("docx");
  XLSX = await ooxml("xlsx");
});

afterAll(async () => {
  await purgeCalculationNotes(sql, createdIds);
  if (counterBefore === null) await sql(`DELETE FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  else await sql(`UPDATE calculation_note_counters SET "lastValue" = :v WHERE year = :y`, { v: counterBefore, y: YEAR });
  fs.rmSync(STORAGE, { recursive: true, force: true });
  await sequelize.close();
});

describe("Documents complémentaires de l'utilisateur affecté", () => {
  let note;
  let initial;

  test("création avec plusieurs documents : nom réel du fichier, type et commentaire, origine « initial »", async () => {
    expect(PROJECT).toBeTruthy();
    const res = await createNote(A.user.id, [[pdf("calcul"), "Calcul dalle R+1.pdf"], [DOCX, "Hypothèses.docx"], [XLSX, "Métré.xlsx"]], {
      types: ["note_de_calcul", "hypotheses", "metre"],
      comments: ["Calcul principal", "Charges d'exploitation", ""],
    });
    expect(res.status).toBe(201);
    note = res.body.data;
    initial = note.documents;
    expect(initial.map((d) => [d.originalName, d.documentType, d.commentaire, d.origin, d.title])).toEqual([
      ["Calcul dalle R+1.pdf", "note_de_calcul", "Calcul principal", "INITIAL", null],
      ["Hypothèses.docx", "hypotheses", "Charges d'exploitation", "INITIAL", null],
      ["Métré.xlsx", "metre", null, "INITIAL", null],
    ]);
    expect(note.assignedTo.id).toBe(A.user.id);
  });

  test("l'utilisateur affecté consulte toutes les informations et télécharge les documents initiaux", async () => {
    const res = await request(app).get(`/calculation-notes/${note.id}`).set(A.auth);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      id: note.id,
      reference: note.reference,
      status: "EN_ATTENTE_VALIDATION",
      commentaire: "Dalle R+1",
      project: { id: PROJECT.id },
      requester: { id: R.user.id },
      creator: { id: C.user.id },
      assignedTo: { id: A.user.id },
      canAddComplementary: true,
      canEdit: false,
      canDecide: false,
    });
    expect(d.documents.map((x) => x.commentaire)).toEqual(["Calcul principal", "Charges d'exploitation", null]);
    for (const [doc, buf] of [[d.documents[0], pdf("calcul")], [d.documents[1], DOCX], [d.documents[2], XLSX]]) {
      const dl = await request(app).get(`/calculation-notes/${note.id}/documents/${doc.id}/download`).set(A.auth).buffer(true).parse(binary);
      expect([dl.status, Buffer.compare(dl.body, buf)]).toEqual([200, 0]);
    }
  });

  test("dépôt complémentaire : enregistré, tracé, documents initiaux intacts, statut inchangé", async () => {
    const before = await sql(`SELECT id, "originalName", sha256, commentaire, "documentType", "storedFileName" FROM calculation_note_documents WHERE "noteId" = :id ORDER BY "createdAt"`, { id: note.id });
    const res = await upload(`/calculation-notes/${note.id}/complementary-documents`, A.auth, [[pdf("plan"), "Plan ferraillage.pdf"], [DOCX, "Réponse.docx"]], {
      types: ["plan", null],
      comments: ["Plan mis à jour", "Réponse aux hypothèses"],
    });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d.status).toBe("EN_ATTENTE_VALIDATION"); // jamais de validation automatique
    expect(d.documents).toHaveLength(5);
    const comp = d.documents.filter((x) => x.origin === "COMPLEMENTARY");
    expect(comp.map((x) => [x.originalName, x.documentType, x.commentaire, x.uploadedBy.id])).toEqual([
      ["Plan ferraillage.pdf", "plan", "Plan mis à jour", A.user.id],
      ["Réponse.docx", null, "Réponse aux hypothèses", A.user.id],
    ]);
    expect(comp.every((x) => x.createdAt)).toBe(true);
    // Initiaux : mêmes lignes, mêmes fichiers, mêmes commentaires.
    const after = await sql(`SELECT id, "originalName", sha256, commentaire, "documentType", "storedFileName" FROM calculation_note_documents WHERE "noteId" = :id AND origin = 'INITIAL' ORDER BY "createdAt"`, { id: note.id });
    expect(after).toEqual(before);
    for (const f of after) expect(fs.existsSync(path.join(STORAGE, f.storedFileName))).toBe(true);
    expect(new Set((await sql(`SELECT "storedFileName" FROM calculation_note_documents WHERE "noteId" = :id`, { id: note.id })).map((x) => x.storedFileName)).size).toBe(5);
    // Historique.
    const h = await request(app).get(`/calculation-notes/${note.id}/history`).set(C.auth);
    expect(h.body.data[0]).toMatchObject({
      action: "COMPLEMENTARY_DOCUMENTS_ADDED",
      user: { id: A.user.id },
      details: { count: 2, complementaryVersion: 1, documents: [{ originalName: "Plan ferraillage.pdf", documentType: "plan", commentaire: "Plan mis à jour" }, { originalName: "Réponse.docx", documentType: null, commentaire: "Réponse aux hypothèses" }] },
    });
    expect(h.body.data.filter((x) => x.action === "DOCUMENT_ADDED" && x.details.origin === "COMPLEMENTARY").map((x) => x.user.id)).toEqual([A.user.id, A.user.id]);
    expect(h.body.data.filter((x) => x.action === "DOCUMENT_ADDED" && x.details.origin === "INITIAL")).toHaveLength(3);
  });

  test("notifications : créateur, demandeur et validateur (interne + email), jamais l'auteur du dépôt", async () => {
    await flushNotifications();
    const notes = await notificationsOf(note.id, "CALCULATION_NOTE_COMPLEMENTARY_DOCUMENTS");
    expect(notes.map((n) => n.userId).sort()).toEqual([C.user.id, R.user.id, V.user.id].sort());
    expect(notes.every((n) => n.calculationNoteVersion === 1)).toBe(true);
    const mails = await emailsOf(note.id, "CALCULATION_NOTE_COMPLEMENTARY_DOCUMENTS");
    expect(mails.map((m) => m.to).sort()).toEqual([C.user.email, R.user.email, V.user.email].sort());
    for (const m of mails) {
      expect(m).toMatchObject({ subject: `Documents complémentaires ajoutés – Note de calcul ${note.reference}`, status: "SENT" });
      for (const part of [
        `Référence : ${note.reference}`,
        `Projet : ${PROJECT.nomProjet}`,
        `Ajoutés par : ${names[A.user.id]} (${A.user.email})`,
        "Nombre de documents ajoutés : 2",
        "Types de documents : Plan, Non précisé",
        "Commentaires : Plan ferraillage.pdf : Plan mis à jour ; Réponse.docx : Réponse aux hypothèses",
        `/notes-calcul/detail?id=${note.id}`,
      ]) {
        expect(m.text).toContain(part);
      }
    }
    const toV = mails.find((m) => m.to === V.user.email);
    expect(toV.text).toContain("La note reste en attente de votre décision.");
    expect(toV.text).toContain("Ouvrir la page de validation");
  });

  test("droits : seul l'utilisateur affecté dépose (backend) ; contenu vérifié ; rien n'est enregistré sinon", async () => {
    const files = [[pdf("x"), "x.pdf"]];
    for (const [who, auth, status, code] of [
      ["créateur", C.auth, 403, "NOT_ASSIGNEE"],
      ["demandeur", R.auth, 403, "NOT_ASSIGNEE"],
      ["validateur", V.auth, 403, "NOT_ASSIGNEE"],
      ["admin", ADMIN.auth, 403, "NOT_ASSIGNEE"],
      ["sans lien", O.auth, 404, "NOT_FOUND"],
    ]) {
      const r = await upload(`/calculation-notes/${note.id}/complementary-documents`, auth, files);
      expect([who, r.status, r.body.code]).toEqual([who, status, code]);
    }
    if (BACKOFFICE) {
      const r = await upload(`/calculation-notes/${note.id}/complementary-documents`, BACKOFFICE, files);
      expect([r.status, r.body.code]).toEqual([403, "READ_ONLY_ACCOUNT"]);
    }
    const fake = await upload(`/calculation-notes/${note.id}/complementary-documents`, A.auth, [[Buffer.from("pas un pdf"), "faux.pdf"]]);
    expect([fake.status, fake.body.code]).toEqual([400, "FILE_CONTENT_MISMATCH"]);
    const empty = await upload(`/calculation-notes/${note.id}/complementary-documents`, A.auth, []);
    expect([empty.status, empty.body.code]).toEqual([400, "FILE_REQUIRED"]);
    const [{ n, v }] = await sql(`SELECT (SELECT COUNT(*)::int FROM calculation_note_documents WHERE "noteId" = :id) n, "complementaryVersion" v FROM calculation_notes WHERE id = :id`, { id: note.id });
    expect([n, v]).toEqual([5, 1]);
  });

  test("validation : le validateur voit tous les documents ; seul lui décide ; ensuite plus de dépôt", async () => {
    const queue = await request(app).get("/calculation-notes/validation?limit=100").set(V.auth);
    expect(queue.body.data.find((x) => x.id === note.id)).toMatchObject({ documentsCount: 5, status: "EN_ATTENTE_VALIDATION" });
    const det = await request(app).get(`/calculation-notes/${note.id}`).set(V.auth);
    expect(det.body.data.documents.map((x) => x.origin)).toEqual(["INITIAL", "INITIAL", "INITIAL", "COMPLEMENTARY", "COMPLEMENTARY"]);
    expect(det.body.data.canAddComplementary).toBe(false);
    expect((await request(app).post(`/calculation-notes/${note.id}/validate`).set(A.auth).send({})).body.code).toBe("NOT_VALIDATOR");
    const ok = await request(app).post(`/calculation-notes/${note.id}/validate`).set(V.auth).send({});
    expect(ok.body.data.status).toBe("VALIDEE");
    await flushNotifications();
    expect((await notificationsOf(note.id, "CALCULATION_NOTE_VALIDATED")).map((x) => x.userId)).toEqual(expect.arrayContaining([C.user.id, R.user.id, A.user.id]));
    const late = await upload(`/calculation-notes/${note.id}/complementary-documents`, A.auth, [[pdf("late"), "tard.pdf"]]);
    expect([late.status, late.body.code]).toEqual([409, "NOTE_LOCKED"]);
    expect((await request(app).get(`/calculation-notes/${note.id}`).set(A.auth)).body.data.canAddComplementary).toBe(false);
  });

  test("dépôts successifs : chacun notifié une fois ; après réaffectation, l'ancien affecté ne peut plus déposer", async () => {
    const res = await createNote(A.user.id);
    const id = res.body.data.id;
    for (const i of [1, 2]) {
      expect((await upload(`/calculation-notes/${id}/complementary-documents`, A.auth, [[pdf(`v${i}`), `v${i}.pdf`]])).status).toBe(201);
    }
    await flushNotifications();
    const notes = await notificationsOf(id, "CALCULATION_NOTE_COMPLEMENTARY_DOCUMENTS");
    expect(notes.filter((n) => n.userId === V.user.id).map((n) => n.calculationNoteVersion)).toEqual([1, 2]);
    expect((await emailsOf(id, "CALCULATION_NOTE_COMPLEMENTARY_DOCUMENTS")).filter((m) => m.to === V.user.email)).toHaveLength(2);
    // Réaffectation : l'ancien affecté perd l'accès, le nouveau peut déposer.
    expect((await request(app).put(`/calculation-notes/${id}/assignment`).set(C.auth).send({ assignedToUserId: A2.user.id })).status).toBe(200);
    expect((await upload(`/calculation-notes/${id}/complementary-documents`, A.auth, [[pdf("old"), "old.pdf"]])).status).toBe(404);
    expect((await upload(`/calculation-notes/${id}/complementary-documents`, A2.auth, [[pdf("new"), "new.pdf"]])).status).toBe(201);
    const docs = await sql(`SELECT "originalName", origin, "uploadedBy" FROM calculation_note_documents WHERE "noteId" = :id ORDER BY "createdAt"`, { id });
    expect(docs.map((d) => [d.originalName, d.origin, d.uploadedBy])).toEqual([
      ["v1.pdf", "COMPLEMENTARY", A.user.id],
      ["v2.pdf", "COMPLEMENTARY", A.user.id],
      ["new.pdf", "COMPLEMENTARY", A2.user.id],
    ]);
    // Ajout par un éditeur (créateur) : origine « ajouté ensuite », distincte.
    const added = await upload(`/calculation-notes/${id}/documents`, C.auth, [[pdf("ed"), "editeur.pdf"]]);
    expect(added.body.data.documents.find((d) => d.originalName === "editeur.pdf").origin).toBe("ADDED");
  });
});
