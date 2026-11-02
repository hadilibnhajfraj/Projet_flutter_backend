"use strict";

// Workflow de validation des notes de calcul — contre la base de
// DÉVELOPPEMENT locale (jamais la production). Comptes et projets réels :
//   validateur  medwethekgc@gmail.com (résolu par son ID)
//   créateur    dhouib.maissa@esprit.tn (sur l'un de SES projets actifs)
//   demandeur   info@probardistribution.com
// Les notes, notifications et emails créés ici sont retirés à la fin et le
// compteur annuel est remis à sa valeur d'origine.

const os = require("os");
const fs = require("fs");
const path = require("path");

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "nc-validation-"));
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
const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const { tunisYear } = require("../src/modules/calculation-notes/services/calculationNote.service");
const { flushNotifications, notifySubmitted } = require("../src/modules/calculation-notes/services/calculationNoteNotify.service");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");
const { purgeCalculationNotes } = require("./helpers/calculationNotes");

const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const YEAR = tunisYear();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const createdIds = [];
let counterBefore;
let V; // validateur
let C; // créateur
let R; // demandeur
let O; // autre utilisateur CRM, sans lien
let ADMIN;
let BACKOFFICE;
let PROJECT;

const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });
async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte de test absent : ${email}`);
  return { user: u, auth: tokenFor(u) };
}

const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

async function create({ files = [], commentaire = "Dalle niveau R+1" } = {}) {
  const r = request(app).post("/calculation-notes").set(C.auth).field("projectId", PROJECT.id).field("requesterId", R.user.id).field("commentaire", commentaire);
  if (files.length) r.field("commentaires", JSON.stringify(files.map((_, i) => `Commentaire document ${i + 1}`)));
  for (const [buf, name] of files) r.attach("files", buf, name);
  const res = await r;
  if (res.status === 201) createdIds.push(res.body.data.id);
  return res;
}

const notificationsOf = (noteId) =>
  sql(`SELECT "userId", type, title, message, "isRead", "calculationNoteVersion" FROM notifications WHERE "calculationNoteId" = :noteId ORDER BY "createdAt"`, { noteId });
const emailsOf = (noteId) =>
  sql(`SELECT "to", subject, text, status FROM email_queue WHERE context = 'calculation-note-validation' AND (meta->>'calculationNoteId')::int = :noteId ORDER BY "createdAt"`, { noteId });

beforeAll(async () => {
  [V, C, R, O, ADMIN] = await Promise.all([
    account("medwethekgc@gmail.com"),
    account("dhouib.maissa@esprit.tn"),
    account("info@probardistribution.com"),
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
    { c: C.user.id, others: [V.user.id, O.user.id] }
  );
  const [c] = await sql(`SELECT "lastValue" FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  counterBefore = c ? c.lastValue : null;
});

afterAll(async () => {
  await purgeCalculationNotes(sql, createdIds);
  if (counterBefore === null) await sql(`DELETE FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  else await sql(`UPDATE calculation_note_counters SET "lastValue" = :v WHERE year = :y`, { v: counterBefore, y: YEAR });
  fs.rmSync(STORAGE, { recursive: true, force: true });
  await sequelize.close();
});

describe("Validation des notes de calcul", () => {
  let note1; // validée
  let note2; // refusée puis soumise de nouveau
  let note3; // annulée

  test("1. création : EN_ATTENTE_VALIDATION, validateur par son ID, notification + email au validateur", async () => {
    expect(PROJECT).toBeTruthy();
    const res = await create({ files: [[PDF, "calcul.pdf"]] });
    expect(res.status).toBe(201);
    note1 = res.body.data;
    expect(note1).toMatchObject({
      status: "EN_ATTENTE_VALIDATION",
      statusLabel: "En attente de validation",
      submissionVersion: 1,
      creator: { id: C.user.id },
      requester: { id: R.user.id },
      validator: { id: V.user.id, email: "medwethekgc@gmail.com" },
      canDecide: false, // le créateur ne décide pas
      canCancel: true,
    });
    const [row] = await sql(`SELECT status, "validatorId", "createdBy", "submittedAt", "createdAt" FROM calculation_notes WHERE id = :id`, { id: note1.id });
    expect(row).toMatchObject({ status: "EN_ATTENTE_VALIDATION", validatorId: V.user.id, createdBy: C.user.id });
    expect(row.submittedAt).toBeTruthy();
    expect(note1.history.find((h) => h.action === "NOTE_SUBMITTED")).toMatchObject({ user: { id: C.user.id }, details: { validatorId: V.user.id, validatorEmail: "medwethekgc@gmail.com" } });

    await flushNotifications();
    const notes = await notificationsOf(note1.id);
    expect(notes).toEqual([expect.objectContaining({ userId: V.user.id, type: "CALCULATION_NOTE_PENDING", isRead: false, calculationNoteVersion: 1 })]);
    const [mail] = await emailsOf(note1.id);
    expect(mail).toMatchObject({ to: "medwethekgc@gmail.com", status: "SENT" });
    expect(mail.subject).toContain(note1.reference);
    for (const part of [`Référence : ${note1.reference}`, `Projet : ${PROJECT.nomProjet}`, "Demandeur : ", "Créateur : ", "Date de création : ", "Observations générales : Dalle niveau R+1", "Statut : En attente de validation", `/notes-calcul/detail?id=${note1.id}`]) {
      expect(mail.text).toContain(part);
    }

    // Rubrique « Validation des notes de calcul » et droits.
    const perm = await request(app).get("/calculation-notes/permissions").set(V.auth);
    expect(perm.body.data.isValidator).toBe(true);
    expect(perm.body.data.pendingToValidate).toBeGreaterThanOrEqual(1);
    const queue = await request(app).get("/calculation-notes/validation?status=EN_ATTENTE_VALIDATION&limit=100").set(V.auth);
    expect(queue.status).toBe(200);
    expect(queue.body.data.find((n) => n.id === note1.id)).toMatchObject({ canDecide: true, status: "EN_ATTENTE_VALIDATION", documentsCount: 1, observations: "Dalle niveau R+1" });
    expect((await request(app).get("/calculation-notes/permissions").set(C.auth)).body.data).toEqual({ isValidator: false, pendingToValidate: 0 });
  });

  test("2. le validateur consulte la note, les commentaires et télécharge les documents", async () => {
    const det = await request(app).get(`/calculation-notes/${note1.id}`).set(V.auth);
    expect(det.status).toBe(200);
    expect(det.body.data).toMatchObject({ canDecide: true, canEdit: false, commentaire: "Dalle niveau R+1" });
    expect(det.body.data.documents[0].commentaire).toBe("Commentaire document 1");
    const dl = await request(app).get(`/calculation-notes/${note1.id}/documents/${det.body.data.documents[0].id}/download`).set(V.auth).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body, PDF)).toBe(0);
  });

  test("7. personne d'autre ne peut valider ou refuser (backend), ni ouvrir la rubrique du validateur", async () => {
    for (const [who, auth, status, code] of [
      ["créateur", C.auth, 403, "NOT_VALIDATOR"],
      ["demandeur", R.auth, 403, "NOT_VALIDATOR"],
      ["admin", ADMIN.auth, 403, "NOT_VALIDATOR"],
      ["sans lien", O.auth, 404, "NOT_FOUND"],
    ]) {
      for (const action of ["validate", "reject"]) {
        const r = await request(app).post(`/calculation-notes/${note1.id}/${action}`).set(auth).send({ commentaire: "tentative" });
        expect([who, action, r.status, r.body.code]).toEqual([who, action, status, code]);
      }
    }
    // (Le back-office, lui, peut décider : voir test/calculationNoteBackoffice.test.js.)
    const [p1] = await sql(`SELECT id, email, role FROM users WHERE email = 'production_1@cbi-tunisia.com'`);
    if (p1) expect((await request(app).post(`/calculation-notes/${note1.id}/validate`).set(tokenFor(p1)).send({})).status).toBe(403);
    expect((await request(app).get("/calculation-notes/validation").set(C.auth)).status).toBe(403);
    const [row] = await sql(`SELECT status FROM calculation_notes WHERE id = :id`, { id: note1.id });
    expect(row.status).toBe("EN_ATTENTE_VALIDATION");
  });

  test("4. refus sans commentaire : bloqué", async () => {
    for (const body of [{}, { commentaire: "" }, { commentaire: "   " }]) {
      const r = await request(app).post(`/calculation-notes/${note1.id}/reject`).set(V.auth).send(body);
      expect([r.status, r.body.code]).toEqual([400, "REJECTION_COMMENT_REQUIRED"]);
    }
    const [row] = await sql(`SELECT status FROM calculation_notes WHERE id = :id`, { id: note1.id });
    expect(row.status).toBe("EN_ATTENTE_VALIDATION");
  });

  test("3/8. validation : VALIDEE, validateur et date enregistrés, créateur + demandeur notifiés ; jamais deux fois", async () => {
    const r = await request(app).post(`/calculation-notes/${note1.id}/validate`).set(V.auth).send({});
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "VALIDEE", decidedBy: { id: V.user.id }, canDecide: false, canEdit: false, canCancel: false });
    expect(r.body.data.decidedAt).toBeTruthy();
    // Une seule décision.
    for (const action of ["validate", "reject"]) {
      const again = await request(app).post(`/calculation-notes/${note1.id}/${action}`).set(V.auth).send({ commentaire: "encore" });
      expect([again.status, again.body.code, again.body.status]).toEqual([409, "ALREADY_DECIDED", "VALIDEE"]);
    }
    await flushNotifications();
    const notes = await notificationsOf(note1.id);
    const decided = notes.filter((n) => n.type === "CALCULATION_NOTE_VALIDATED");
    expect(decided.map((n) => n.userId).sort()).toEqual([C.user.id, R.user.id, V.user.id].sort());
    const mails = (await emailsOf(note1.id)).filter((m) => m.subject.startsWith("Note de calcul validée"));
    expect(mails.map((m) => m.to).sort()).toEqual([C.user.email, R.user.email].sort());
    expect(mails[0].text).toContain("Statut : Validée");
    // Note validée : verrouillée (ni modification, ni ajout, ni annulation).
    const upd = await request(app).patch(`/calculation-notes/${note1.id}`).set(C.auth).send({ commentaire: "modif" });
    expect([upd.status, upd.body.code]).toEqual([409, "NOTE_LOCKED"]);
    const add = await request(app).post(`/calculation-notes/${note1.id}/documents`).set(C.auth).attach("files", PDF, "x.pdf");
    expect([add.status, add.body.code]).toEqual([409, "NOTE_LOCKED"]);
    const cancel = await request(app).post(`/calculation-notes/${note1.id}/cancel`).set(C.auth).send({ motif: "plus utile" });
    expect([cancel.status, cancel.body.code]).toEqual([409, "NOTE_LOCKED"]);
  });

  test("8. décisions concurrentes : une seule aboutit", async () => {
    const res = await create();
    const id = res.body.data.id;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => request(app).post(`/calculation-notes/${id}/${i % 2 ? "reject" : "validate"}`).set(V.auth).send({ commentaire: `décision ${i}` }))
    );
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    expect(results.filter((x) => x.status === 409).every((x) => x.body.code === "ALREADY_DECIDED")).toBe(true);
    const [{ n }] = await sql(`SELECT COUNT(*)::int n FROM calculation_note_histories WHERE "noteId" = :id AND action IN ('NOTE_VALIDATED','NOTE_REJECTED')`, { id });
    expect(n).toBe(1);
  });

  test("5. refus avec commentaire : REFUSEE, motif enregistré et notifié ; puis nouvelle soumission notifiée", async () => {
    const res = await create({ files: [[PDF, "v1.pdf"]] });
    note2 = res.body.data;
    const r = await request(app).post(`/calculation-notes/${note2.id}/reject`).set(V.auth).send({ commentaire: "Hypothèses de charge manquantes" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "REFUSEE", decisionComment: "Hypothèses de charge manquantes", decidedBy: { id: V.user.id } });
    await flushNotifications();
    const rejected = (await notificationsOf(note2.id)).filter((n) => n.type === "CALCULATION_NOTE_REJECTED");
    expect(rejected.map((n) => n.userId).sort()).toEqual([C.user.id, R.user.id, V.user.id].sort());
    expect(rejected.every((n) => n.message.includes("Hypothèses de charge manquantes"))).toBe(true);
    const mail = (await emailsOf(note2.id)).find((m) => m.to === C.user.email && m.subject.startsWith("Note de calcul refusée"));
    expect(mail.text).toContain("Motif du refus : Hypothèses de charge manquantes");
    expect(mail.text).toContain("Statut : Refusée");

    // Corrigée puis soumise de nouveau (n° 2) → validateur notifié.
    const fix = await request(app).post(`/calculation-notes/${note2.id}/documents`).set(C.auth).attach("files", PDF, "v2.pdf");
    expect(fix.status).toBe(201);
    const re = await request(app).post(`/calculation-notes/${note2.id}/resubmit`).set(C.auth).send({});
    expect(re.body.data).toMatchObject({ status: "EN_ATTENTE_VALIDATION", submissionVersion: 2, decisionComment: null });
    await flushNotifications();
    expect((await notificationsOf(note2.id)).filter((n) => n.type === "CALCULATION_NOTE_RESUBMITTED")).toEqual([
      expect.objectContaining({ userId: V.user.id, calculationNoteVersion: 2 }),
    ]);
    // Décision fondée sur l'ancienne soumission : refusée.
    const stale = await request(app).post(`/calculation-notes/${note2.id}/validate`).set(V.auth).send({ submissionVersion: 1 });
    expect([stale.status, stale.body.code]).toEqual([409, "STALE_SUBMISSION"]);
    // Une note en attente ne peut pas être « resoumise ».
    expect((await request(app).post(`/calculation-notes/${note2.id}/resubmit`).set(C.auth).send({})).body.code).toBe("NOT_REJECTED");
  });

  test("6. annulation par le créateur (motif obligatoire) : ANNULEE, validateur informé, distincte d'un refus", async () => {
    const res = await create();
    note3 = res.body.data;
    const noReason = await request(app).post(`/calculation-notes/${note3.id}/cancel`).set(C.auth).send({ motif: " " });
    expect([noReason.status, noReason.body.code]).toEqual([400, "CANCELLATION_REASON_REQUIRED"]);
    const notCreator = await request(app).post(`/calculation-notes/${note3.id}/cancel`).set(R.auth).send({ motif: "doublon" });
    expect([notCreator.status, notCreator.body.code]).toEqual([403, "NOT_CREATOR"]);
    const ok = await request(app).post(`/calculation-notes/${note3.id}/cancel`).set(C.auth).send({ motif: "Note créée en double" });
    expect(ok.body.data).toMatchObject({ status: "ANNULEE", statusLabel: "Annulée", cancelledBy: { id: C.user.id }, cancellationReason: "Note créée en double", decidedBy: null });
    await flushNotifications();
    const cancelled = (await notificationsOf(note3.id)).filter((n) => n.type === "CALCULATION_NOTE_CANCELLED");
    expect(cancelled).toEqual([expect.objectContaining({ userId: V.user.id })]);
    expect(cancelled[0].message).toContain("Note créée en double");
    const mail = (await emailsOf(note3.id)).find((m) => m.subject.startsWith("Note de calcul annulée"));
    expect(mail).toMatchObject({ to: "medwethekgc@gmail.com" });
    expect(mail.text).toContain("Statut : Annulée");
    // Plus de décision possible, ni seconde annulation.
    expect((await request(app).post(`/calculation-notes/${note3.id}/validate`).set(V.auth).send({})).body.code).toBe("ALREADY_DECIDED");
    expect((await request(app).post(`/calculation-notes/${note3.id}/cancel`).set(C.auth).send({ motif: "encore" })).body.code).toBe("ALREADY_CANCELLED");
  });

  test("9. historique complet conservé après chaque décision", async () => {
    const h = await request(app).get(`/calculation-notes/${note2.id}/history`).set(C.auth);
    const actions = h.body.data.map((x) => x.action).reverse();
    expect(actions).toEqual(["NOTE_CREATED", "DOCUMENT_ADDED", "NOTE_SUBMITTED", "NOTE_REJECTED", "DOCUMENT_ADDED", "NOTE_RESUBMITTED"]);
    const rejected = h.body.data.find((x) => x.action === "NOTE_REJECTED");
    expect(rejected).toMatchObject({ user: { id: V.user.id, email: "medwethekgc@gmail.com" }, details: { commentaire: "Hypothèses de charge manquantes", submissionVersion: 1 } });
    expect(h.body.data.every((x) => x.createdAt && x.user?.id)).toBe(true);
    const h3 = await request(app).get(`/calculation-notes/${note3.id}/history`).set(V.auth);
    expect(h3.body.data[0]).toMatchObject({ action: "NOTE_CANCELLED", user: { id: C.user.id }, details: { motif: "Note créée en double", previousStatus: "EN_ATTENTE_VALIDATION" } });
    const h1 = await request(app).get(`/calculation-notes/${note1.id}/history`).set(R.auth);
    expect(h1.body.data[0]).toMatchObject({ action: "NOTE_VALIDATED", user: { id: V.user.id } });
  });

  test("10. notifications conservées en base (destinataire hors ligne), lues plus tard, sans doublon", async () => {
    // Nouvelle « connexion » plus tard : la liste vient de la base.
    const later = await request(app).get("/notifications?limit=100").set(tokenFor(V.user));
    const mine = later.body.items.filter((n) => [note1.id, note2.id, note3.id].includes(n.calculationNoteId));
    expect(mine.map((n) => n.type).sort()).toEqual(
      ["CALCULATION_NOTE_PENDING", "CALCULATION_NOTE_VALIDATED", "CALCULATION_NOTE_PENDING", "CALCULATION_NOTE_REJECTED", "CALCULATION_NOTE_RESUBMITTED", "CALCULATION_NOTE_PENDING", "CALCULATION_NOTE_CANCELLED"].sort()
    );
    expect(mine.every((n) => n.isRead === false)).toBe(true);
    const forCreator = await request(app).get("/notifications?limit=100").set(tokenFor(C.user));
    expect(forCreator.body.items.filter((n) => n.calculationNoteId === note1.id).map((n) => n.type)).toEqual(["CALCULATION_NOTE_VALIDATED"]);
    // Nouvelle tentative d'envoi pour la même soumission : aucun doublon.
    await notifySubmitted(note1.id);
    await flushNotifications();
    expect((await notificationsOf(note1.id)).filter((n) => n.type === "CALCULATION_NOTE_PENDING")).toHaveLength(1);
    expect((await emailsOf(note1.id)).filter((m) => m.to === "medwethekgc@gmail.com" && m.subject.startsWith("Nouvelle demande de validation"))).toHaveLength(1);
  });

  test("liste : filtre par statut, indicateurs par statut ; back-office en lecture seule", async () => {
    const validated = await request(app).get(`/calculation-notes?status=VALIDEE&projectId=${PROJECT.id}&limit=100`).set(C.auth);
    expect(validated.body.data.every((n) => n.status === "VALIDEE")).toBe(true);
    expect(validated.body.data.map((n) => n.id)).toContain(note1.id);
    const all = await request(app).get(`/calculation-notes?limit=1`).set(C.auth);
    for (const k of ["EN_ATTENTE_VALIDATION", "VALIDEE", "REFUSEE", "ANNULEE"]) expect(typeof all.body.summary[k]).toBe("number");
    const [{ n }] = await sql(
      `SELECT COUNT(*)::int n FROM calculation_notes WHERE status = 'ANNULEE' AND ("createdBy" = :c OR "requesterId" = :c OR "validatorId" = :c OR "projectId" IN (SELECT id FROM projects WHERE "ownerId" = :c UNION SELECT "projectId" FROM user_projects WHERE "userId" = :c))`,
      { c: C.user.id }
    );
    expect(all.body.summary.ANNULEE).toBe(n);
    if (BACKOFFICE) {
      // Annuler / soumettre de nouveau : jamais pour le back-office.
      for (const [path, body] of [[`/calculation-notes/${note2.id}/cancel`, { motif: "x" }], [`/calculation-notes/${note2.id}/resubmit`, {}]]) {
        const r = await request(app).post(path).set(BACKOFFICE).send(body);
        expect([r.status, r.body.code]).toEqual([403, "READ_ONLY_ACCOUNT"]);
      }
      // Consultation : la note, avec décision possible (en attente).
      const bo = await request(app).get(`/calculation-notes/${note2.id}`).set(BACKOFFICE);
      expect(bo.body.data).toMatchObject({ id: note2.id, status: "EN_ATTENTE_VALIDATION", canDecide: true, canCancel: false, canEdit: false });
    }
  });

  test("validateur introuvable : création refusée avec un message explicite, aucun compte créé", async () => {
    const before = await sql(`SELECT COUNT(*)::int n FROM users`);
    process.env.CALCULATION_NOTE_VALIDATOR_EMAIL = "validateur-inexistant@example.com";
    try {
      const r = await create({ files: [[PDF, "x.pdf"]] });
      expect([r.status, r.body.code]).toEqual([503, "VALIDATOR_UNAVAILABLE"]);
      expect(r.body.message).toContain("validateur-inexistant@example.com");
    } finally {
      delete process.env.CALCULATION_NOTE_VALIDATOR_EMAIL;
    }
    expect(await sql(`SELECT COUNT(*)::int n FROM users`)).toEqual(before);
    expect(fs.readdirSync(STORAGE).filter((f) => f.endsWith(".pdf"))).toHaveLength(3); // seuls les documents des notes créées (note1 + 2 pour note2)
  });
});
