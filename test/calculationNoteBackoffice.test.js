"use strict";

// Notes de calcul vues par le compte BACK-OFFICE (backoffice@cbi-tunisia.com)
// — contre la base de DÉVELOPPEMENT locale (jamais la production).
// Connexion RÉELLE (POST /auth/signin) : mot de passe lu dans la variable
// d'environnement BACKOFFICE_PASSWORD, jamais écrit ni affiché.
//
// Régression couverte : le back-office voyait 0 note — ses lectures étaient
// exécutées avec l'identité de son compte de référence (commercial), et la
// portée de lecture du module ne retenait que les notes de ce compte. Il doit
// voir TOUTES les notes (vue globale), pouvoir valider / refuser, et rester en
// lecture seule partout ailleurs.
//
// Données réelles : les notes déjà présentes en base ne sont ni modifiées ni
// supprimées ; les notes créées ici (comptes CRM réels) sont retirées à la
// fin et le compteur annuel est remis à sa valeur d'origine.

const os = require("os");
const fs = require("fs");
const path = require("path");

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "nc-backoffice-"));
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
const { flushNotifications } = require("../src/modules/calculation-notes/services/calculationNoteNotify.service");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");
const { purgeCalculationNotes } = require("./helpers/calculationNotes");

const PASSWORD = process.env.BACKOFFICE_PASSWORD;
const describeIfPassword = PASSWORD ? describe : describe.skip;

const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const YEAR = tunisYear();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const createdIds = [];
let counterBefore;
let existingBefore;
let BO; // jeton obtenu par connexion réelle
let BO_USER;
let C1; // créateur 1
let C2; // créateur 2
let R; // demandeur
let V; // validateur officiel
let ADMIN;

const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });
async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte de test absent : ${email}`);
  return { user: u, auth: tokenFor(u) };
}
async function projectOf(owner) {
  const [p] = await sql(`SELECT id, "nomProjet" FROM projects WHERE "ownerId" = :o AND COALESCE("isArchived", false) = false ORDER BY "createdAt" LIMIT 1`, { o: owner.user.id });
  return p;
}
async function create(creator, project, { files = [], comments } = {}) {
  const r = request(app).post("/calculation-notes").set(creator.auth).field("projectId", project.id).field("requesterId", R.user.id).field("commentaire", `Note de ${creator.user.email}`);
  if (comments) r.field("commentaires", JSON.stringify(comments));
  for (const [buf, name] of files) r.attach("files", buf, name);
  const res = await r;
  if (res.status === 201) createdIds.push(res.body.data.id);
  return res;
}
const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  if (!PASSWORD) return;
  [C1, C2, R, V, ADMIN] = await Promise.all([
    account("dhouib.maissa@esprit.tn"),
    account("faycelmarzouk@probardistribution.com"),
    account("info@probardistribution.com"),
    account("medwethekgc@gmail.com"),
    account("cbitunisia@cbi-tunisia.com"),
  ]);
  _resetCache();
  const res = await request(app).post("/auth/signin").send({ email: "backoffice@cbi-tunisia.com", password: PASSWORD });
  expect(res.status).toBe(200);
  BO = { Authorization: `Bearer ${res.body.accessToken}` };
  [BO_USER] = await sql(`SELECT id, email, role FROM users WHERE email = 'backoffice@cbi-tunisia.com'`);
  const [c] = await sql(`SELECT "lastValue" FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  counterBefore = c ? c.lastValue : null;
  existingBefore = await sql(`SELECT id, reference, status, "updatedAt" FROM calculation_notes ORDER BY id`);
});

afterAll(async () => {
  if (PASSWORD) {
    await purgeCalculationNotes(sql, createdIds);
    if (counterBefore === null) await sql(`DELETE FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
    else await sql(`UPDATE calculation_note_counters SET "lastValue" = :v WHERE year = :y`, { v: counterBefore, y: YEAR });
    // Les notes réelles préexistantes n'ont pas bougé.
    expect(await sql(`SELECT id, reference, status, "updatedAt" FROM calculation_notes WHERE id IN (:ids) ORDER BY id`, { ids: existingBefore.map((n) => n.id).concat(-1) })).toEqual(existingBefore);
  }
  fs.rmSync(STORAGE, { recursive: true, force: true });
  await sequelize.close();
});

describeIfPassword("Notes de calcul — compte back-office", () => {
  let n1; // créée par C1, avec documents
  let n2; // créée par C2
  let n3; // refusée par le back-office
  let n4; // annulée

  test("notes réelles existantes : toutes visibles du back-office (vue globale, pas celle du compte de référence)", async () => {
    const [{ total }] = await sql(`SELECT COUNT(*)::int total FROM calculation_notes`);
    const bo = await request(app).get("/calculation-notes?limit=100").set(BO);
    expect(bo.status).toBe(200);
    expect(bo.body.summary.total).toBe(total);
    expect(bo.body.data.map((n) => n.id).sort()).toEqual(existingBefore.map((n) => n.id).sort());
    // Le compte de référence, lui, n'est pas élargi.
    const ref = await request(app).get("/calculation-notes?limit=100").set(R.auth);
    const [{ refTotal }] = await sql(
      `SELECT COUNT(*)::int "refTotal" FROM calculation_notes WHERE "createdBy" = :r OR "requesterId" = :r OR "validatorId" = :r OR "assignedToUserId" = :r
         OR "projectId" IN (SELECT id FROM projects WHERE "ownerId" = :r UNION SELECT "projectId" FROM user_projects WHERE "userId" = :r)`,
      { r: R.user.id }
    );
    expect(ref.body.summary.total).toBe(refTotal);
  });

  test("1-8. notes de plusieurs créateurs : visibles du créateur et du back-office, documents, commentaires, statistiques, tous les statuts", async () => {
    const p1 = await projectOf(C1);
    const p2 = await projectOf(C2);
    n1 = (await create(C1, p1, { files: [[PDF, "calcul.pdf"]], comments: ["Calcul principal"] })).body.data;
    n2 = (await create(C2, p2)).body.data;
    n3 = (await create(C1, p1)).body.data;
    n4 = (await create(C2, p2)).body.data;
    expect([n1, n2, n3, n4].every(Boolean)).toBe(true);
    // Visible du créateur.
    expect((await request(app).get("/calculation-notes?limit=100").set(C1.auth)).body.data.map((n) => n.id)).toEqual(expect.arrayContaining([n1.id, n3.id]));
    // Statuts : refusée (par le validateur), annulée (par le créateur), en attente.
    expect((await request(app).post(`/calculation-notes/${n3.id}/reject`).set(V.auth).send({ commentaire: "Hypothèses manquantes" })).status).toBe(200);
    expect((await request(app).post(`/calculation-notes/${n4.id}/cancel`).set(C2.auth).send({ motif: "Doublon" })).status).toBe(200);

    const bo = await request(app).get("/calculation-notes?limit=100").set(BO);
    const ids = bo.body.data.map((n) => n.id);
    for (const n of [n1, n2, n3, n4]) expect(ids).toContain(n.id);
    // Statistiques = même périmètre que la liste, recalculées en base.
    const s = bo.body.summary;
    const [db] = await sql(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status = 'EN_ATTENTE_VALIDATION')::int pending,
              COUNT(*) FILTER (WHERE status = 'VALIDEE')::int validated,
              COUNT(*) FILTER (WHERE status = 'REFUSEE')::int rejected,
              COUNT(*) FILTER (WHERE status = 'ANNULEE')::int cancelled,
              (SELECT COUNT(*)::int FROM calculation_note_documents) docs
         FROM calculation_notes`
    );
    expect([s.total, s.EN_ATTENTE_VALIDATION, s.VALIDEE, s.REFUSEE, s.ANNULEE, s.documents]).toEqual([db.total, db.pending, db.validated, db.rejected, db.cancelled, db.docs]);
    expect(bo.body.pagination.total).toBe(db.total);
    // « Mes notes » = notes créées par le back-office lui-même (jamais le total).
    const [{ mine }] = await sql(`SELECT COUNT(*)::int mine FROM calculation_notes WHERE "createdBy" = :b`, { b: BO_USER.id });
    expect(s.mine).toBe(mine);
    // Notes par créateur.
    const byCreator = Object.fromEntries(s.byCreator.map((x) => [x.user.email, x.count]));
    const rows = await sql(`SELECT u.email, COUNT(*)::int n FROM calculation_notes c JOIN users u ON u.id = c."createdBy" GROUP BY u.email`);
    expect(byCreator).toEqual(Object.fromEntries(rows.map((r) => [r.email, r.n])));
    // Filtre par statut.
    for (const st of ["EN_ATTENTE_VALIDATION", "REFUSEE", "ANNULEE"]) {
      const f = await request(app).get(`/calculation-notes?status=${st}&limit=100`).set(BO);
      expect(f.body.data.every((n) => n.status === st)).toBe(true);
      expect(f.body.data.length).toBeGreaterThan(0);
    }
    // Détail, documents et commentaires.
    const det = await request(app).get(`/calculation-notes/${n1.id}`).set(BO);
    expect(det.body.data).toMatchObject({ reference: n1.reference, creator: { id: C1.user.id }, commentaire: `Note de ${C1.user.email}`, canDecide: true, canEdit: false, canCancel: false, canAssign: false, canAddComplementary: false });
    expect(det.body.data.documents.map((d) => [d.originalName, d.commentaire])).toEqual([["calcul.pdf", "Calcul principal"]]);
    const dl = await request(app).get(`/calculation-notes/${n1.id}/documents/${det.body.data.documents[0].id}/download`).set(BO).buffer(true).parse(binary);
    expect([dl.status, Buffer.compare(dl.body, PDF)]).toEqual([200, 0]);
    const rej = await request(app).get(`/calculation-notes/${n3.id}`).set(BO);
    expect(rej.body.data).toMatchObject({ status: "REFUSEE", decisionComment: "Hypothèses manquantes", canDecide: false });
    // Rubrique « Validation » : toutes les notes en attente.
    const perm = await request(app).get("/calculation-notes/permissions").set(BO);
    const [{ pending }] = await sql(`SELECT COUNT(*)::int pending FROM calculation_notes WHERE status = 'EN_ATTENTE_VALIDATION'`);
    expect(perm.body.data).toEqual({ isValidator: true, pendingToValidate: pending });
    const queue = await request(app).get("/calculation-notes/validation?status=EN_ATTENTE_VALIDATION&limit=100").set(BO);
    expect(queue.body.data.map((n) => n.id)).toEqual(expect.arrayContaining([n1.id, n2.id]));
  });

  test("9. validation et refus depuis le back-office : identité réelle, motif obligatoire, première décision gagnante, historique", async () => {
    // Refus sans motif : bloqué.
    const empty = await request(app).post(`/calculation-notes/${n2.id}/reject`).set(BO).send({ commentaire: "  " });
    expect([empty.status, empty.body.code]).toEqual([400, "REJECTION_COMMENT_REQUIRED"]);
    // Refus avec motif.
    const rej = await request(app).post(`/calculation-notes/${n2.id}/reject`).set(BO).send({ commentaire: "Plans non conformes" });
    expect(rej.status).toBe(200);
    expect(rej.body.data).toMatchObject({ status: "REFUSEE", decisionComment: "Plans non conformes", decidedBy: { id: BO_USER.id, email: "backoffice@cbi-tunisia.com" } });
    // Validation par le back-office ; le validateur arrive trop tard (aucun double traitement).
    const [boRes, vRes] = await Promise.all([
      request(app).post(`/calculation-notes/${n1.id}/validate`).set(BO).send({}),
      request(app).post(`/calculation-notes/${n1.id}/validate`).set(V.auth).send({}),
    ]);
    expect([boRes.status, vRes.status].sort()).toEqual([200, 409]);
    const [row] = await sql(`SELECT status, "decidedBy" FROM calculation_notes WHERE id = :id`, { id: n1.id });
    expect(row.status).toBe("VALIDEE");
    expect([BO_USER.id, V.user.id]).toContain(row.decidedBy);
    expect((await request(app).post(`/calculation-notes/${n1.id}/reject`).set(BO).send({ commentaire: "Refus tardif" })).body.code).toBe("ALREADY_DECIDED");
    // Historique : une seule décision par note, auteur réel tracé.
    const h = await request(app).get(`/calculation-notes/${n2.id}/history`).set(BO);
    expect(h.body.data[0]).toMatchObject({ action: "NOTE_REJECTED", user: { id: BO_USER.id }, details: { commentaire: "Plans non conformes", decidedAs: "BACKOFFICE" } });
    const [{ d }] = await sql(`SELECT COUNT(*)::int d FROM calculation_note_histories WHERE "noteId" = :id AND action IN ('NOTE_VALIDATED','NOTE_REJECTED')`, { id: n1.id });
    expect(d).toBe(1);
    // Notifications : créateur et demandeur informés ; le validateur aussi.
    await flushNotifications();
    const notified = await sql(`SELECT "userId" FROM notifications WHERE "calculationNoteId" = :id AND type = 'CALCULATION_NOTE_REJECTED'`, { id: n2.id });
    expect(notified.map((x) => x.userId).sort()).toEqual([C2.user.id, R.user.id, V.user.id].sort());
    const [mailV] = await sql(`SELECT text FROM email_queue WHERE context = 'calculation-note-validation' AND "to" = :to AND (meta->>'calculationNoteId')::int = :id AND meta->>'type' = 'CALCULATION_NOTE_REJECTED'`, { to: V.user.email, id: n2.id });
    expect(mailV.text).toContain("Aucune décision n'est plus attendue de votre part.");
    // Le validateur officiel conserve ses droits.
    const n5 = (await create(C1, await projectOf(C1))).body.data;
    expect((await request(app).post(`/calculation-notes/${n5.id}/validate`).set(V.auth).send({})).status).toBe(200);
  });

  test("10. autres écritures et autres modules : toujours en lecture seule", async () => {
    const before = await sql(`SELECT COUNT(*)::int n FROM calculation_notes`);
    const p1 = await projectOf(C1);
    for (const r of [
      request(app).post("/calculation-notes").set(BO).field("projectId", p1.id).field("requesterId", R.user.id),
      request(app).patch(`/calculation-notes/${n2.id}`).set(BO).send({ commentaire: "x" }),
      request(app).post(`/calculation-notes/${n2.id}/documents`).set(BO).attach("files", PDF, "x.pdf"),
      request(app).post(`/calculation-notes/${n2.id}/complementary-documents`).set(BO).attach("files", PDF, "x.pdf"),
      request(app).put(`/calculation-notes/${n2.id}/assignment`).set(BO).send({ assignedToUserId: C1.user.id }),
      request(app).post(`/calculation-notes/${n2.id}/cancel`).set(BO).send({ motif: "x" }),
      request(app).post(`/calculation-notes/${n2.id}/resubmit`).set(BO).send({}),
      request(app).post(`/calculation-notes/${n2.id}/email-notifications/resend`).set(BO).send({}),
      // Chemins voisins : jamais ouverts par l'exception.
      request(app).post(`/calculation-notes/${n2.id}/validate/extra`).set(BO).send({}),
      request(app).post(`/calculation-notes/abc/validate`).set(BO).send({}),
      // Autres modules.
      request(app).post("/projects").set(BO).send({ nomProjet: "x" }),
      request(app).put(`/projects/${p1.id}`).set(BO).send({ nomProjet: "x" }),
      request(app).post("/commercial-contacts").set(BO).send({}),
      request(app).post("/tasks").set(BO).send({}),
      request(app).post("/production-fiche-approvals/promesh/00000000-0000-4000-8000-000000000000/approve").set(BO).send({}),
    ]) {
      const res = await r;
      expect([res.status, res.body.code]).toEqual([403, "READ_ONLY_ACCOUNT"]);
    }
    expect(await sql(`SELECT COUNT(*)::int n FROM calculation_notes`)).toEqual(before);
    // Lectures des autres modules : toujours celles du compte de référence
    // (la liste des contacts commerciaux, globale pour le back-office, est
    // couverte par test/commercialContactsVisibility.test.js).
    const ref = await request(app).get("/projects/my-projects").set(R.auth);
    const bo = await request(app).get("/projects/my-projects").set(BO);
    expect(bo.status).toBe(ref.status);
    expect(bo.body).toEqual(ref.body);
    // Un admin voit toujours toutes les notes (aucune régression).
    const adm = await request(app).get("/calculation-notes?limit=1").set(ADMIN.auth);
    expect(adm.body.summary.total).toBe((await sql(`SELECT COUNT(*)::int n FROM calculation_notes`))[0].n);
  });
});

if (!PASSWORD) test.skip("BACKOFFICE_PASSWORD absent : tests du compte back-office non exécutés", () => {});
