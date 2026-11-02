"use strict";

// Affectation des notes de calcul (« Affecter à ») et emails — contre la base
// de DÉVELOPPEMENT locale (jamais la production). Comptes et projets réels :
//   créateur      dhouib.maissa@esprit.tn (sur l'un de ses projets actifs)
//   demandeur     info@probardistribution.com
//   affectés      faycelmarzouk@probardistribution.com, hadil.ibnhajfraj@gmail.com
//   validateur    medwethekgc@gmail.com
// L'envoi SMTP est simulé (mailer mocké) : succès, panne de connexion, refus
// définitif. Tout ce que le test crée est retiré à la fin ; le compteur annuel
// est remis à sa valeur d'origine.

const os = require("os");
const fs = require("fs");
const path = require("path");

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "nc-assignment-"));
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
const mailer = require("../src/utils/mailer");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const { tunisYear } = require("../src/modules/calculation-notes/services/calculationNote.service");
const { flushNotifications } = require("../src/modules/calculation-notes/services/calculationNoteNotify.service");
const { enqueueEmailOnce, cancelJob } = require("../src/services/emailQueue.service");
const { resolveFullName } = require("../src/utils/userDisplay");
const { User, UserProfile } = require("../src/models/associations");
const { _resetCache } = require("../src/middleware/readOnlyRoleGuard");
const { purgeCalculationNotes } = require("./helpers/calculationNotes");

const sql = (q, replacements = {}) => sequelize.query(q, { replacements, type: sequelize.QueryTypes.SELECT });
const YEAR = tunisYear();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const createdIds = [];
let counterBefore;
let C;
let R;
let A1;
let A2;
let V;
let O;
let BACKOFFICE;
let PROJECT;
const names = {};

const tokenFor = (u) => ({ Authorization: `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}` });
async function account(email) {
  const [u] = await sql(`SELECT id, email, role FROM users WHERE email = :email`, { email });
  if (!u) throw new Error(`compte de test absent : ${email}`);
  const full = await User.findByPk(u.id, { include: [{ model: UserProfile, as: "profile", required: false }] });
  names[u.id] = resolveFullName(full);
  return { user: u, auth: tokenFor(u) };
}

async function create(auth, { assignedToUserId, files = [] } = {}) {
  const r = request(app).post("/calculation-notes").set(auth).field("projectId", PROJECT.id).field("requesterId", R.user.id).field("commentaire", "Vérifier la dalle R+1");
  if (assignedToUserId !== undefined) r.field("assignedToUserId", assignedToUserId);
  if (files.length) {
    r.field("titres", JSON.stringify(files.map(([, , t]) => t)));
    r.field("commentaires", JSON.stringify(files.map((_, i) => `Commentaire ${i + 1}`)));
  }
  for (const [buf, name] of files) r.attach("files", buf, name);
  const res = await r;
  if (res.status === 201) createdIds.push(res.body.data.id);
  return res;
}

const emailsOf = (noteId) =>
  sql(`SELECT id, "to", subject, text, status::text AS status, attempts, "lastErrorMessage", "nextAttemptAt", meta->>'type' AS type FROM email_queue WHERE context = 'calculation-note-validation' AND (meta->>'calculationNoteId')::int = :noteId ORDER BY "createdAt"`, { noteId });
const notificationsOf = (noteId) => sql(`SELECT "userId", type, "calculationNoteVersion" FROM notifications WHERE "calculationNoteId" = :noteId ORDER BY "createdAt"`, { noteId });

beforeAll(async () => {
  [C, R, A1, A2, V, O] = await Promise.all([
    account("dhouib.maissa@esprit.tn"),
    account("info@probardistribution.com"),
    account("faycelmarzouk@probardistribution.com"),
    account("hadil.ibnhajfraj@gmail.com"),
    account("medwethekgc@gmail.com"),
    account("mouemensfax@gmail.com"),
  ]);
  const [bo] = await sql(`SELECT id, email, role FROM users WHERE email = 'backoffice@cbi-tunisia.com'`);
  BACKOFFICE = bo ? tokenFor(bo) : null;
  _resetCache();
  [PROJECT] = await sql(
    `SELECT id, "nomProjet" FROM projects p WHERE p."ownerId" = :c AND COALESCE(p."isArchived", false) = false
       AND NOT EXISTS (SELECT 1 FROM user_projects up WHERE up."projectId" = p.id AND up."userId" IN (:others))
     ORDER BY "createdAt" LIMIT 1`,
    { c: C.user.id, others: [A1.user.id, A2.user.id, V.user.id, O.user.id] }
  );
  const [c] = await sql(`SELECT "lastValue" FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  counterBefore = c ? c.lastValue : null;
});

afterEach(() => {
  mailer.sendMail.mockReset();
  mailer.sendMail.mockResolvedValue({ messageId: "test" });
});

afterAll(async () => {
  await purgeCalculationNotes(sql, createdIds);
  if (counterBefore === null) await sql(`DELETE FROM calculation_note_counters WHERE year = :y`, { y: YEAR });
  else await sql(`UPDATE calculation_note_counters SET "lastValue" = :v WHERE year = :y`, { v: counterBefore, y: YEAR });
  fs.rmSync(STORAGE, { recursive: true, force: true });
  await sequelize.close();
});

describe("Affectation des notes de calcul", () => {
  let note; // affectée à A1 puis A2 puis retirée

  test("1. liste : tous les utilisateurs CRM actifs autorisés, lus en base, avec recherche", async () => {
    expect(PROJECT).toBeTruthy();
    const res = await request(app).get("/calculation-notes/assignable-users").set(C.auth);
    expect(res.status).toBe(200);
    const [{ n }] = await sql(`SELECT COUNT(*)::int n FROM users WHERE "isActive" AND role IN ('user','commercial','admin','superadmin','superadmin2')`);
    expect(res.body.data).toHaveLength(n);
    const emails = res.body.data.map((u) => u.email);
    for (const e of [A1.user.email, A2.user.email, V.user.email]) expect(emails).toContain(e);
    // Jamais : back-office, accueil, rôles industriels / finance / qualité, comptes inactifs.
    const excluded = await sql(`SELECT email FROM users WHERE NOT "isActive" OR role NOT IN ('user','commercial','admin','superadmin','superadmin2')`);
    expect(excluded.length).toBeGreaterThan(0);
    for (const { email } of excluded) expect(emails).not.toContain(email);
    expect(res.body.data.find((u) => u.email === A2.user.email)).toEqual({ id: A2.user.id, email: A2.user.email, name: names[A2.user.id], role: "user" });
    // Recherche : email, nom.
    const byEmail = await request(app).get("/calculation-notes/assignable-users?q=FAYCELMARZOUK").set(C.auth);
    expect(byEmail.body.data.map((u) => u.email)).toEqual([A1.user.email]);
    const byName = await request(app).get(`/calculation-notes/assignable-users?q=${encodeURIComponent(names[A2.user.id].toLowerCase())}`).set(C.auth);
    expect(byName.body.data.map((u) => u.email)).toContain(A2.user.email);
    const opts = await request(app).get("/calculation-notes/options").set(C.auth);
    expect(opts.body.data.assignees).toHaveLength(n);
    expect(opts.body.data.assigneeRequired).toBe(false);
  });

  test("2-5. création affectée : enregistrée ; email à l'affecté et demande de validation, bonne référence et bon lien", async () => {
    const res = await create(C.auth, { assignedToUserId: A1.user.id, files: [[PDF, "calcul.pdf", "Calcul dalle R+1"], [PDF, "plan.pdf", "Plan de ferraillage"]] });
    expect(res.status).toBe(201);
    note = res.body.data;
    expect(note).toMatchObject({ status: "EN_ATTENTE_VALIDATION", assignedTo: { id: A1.user.id, email: A1.user.email, role: "user" }, assignedBy: { id: C.user.id } });
    const [row] = await sql(`SELECT "assignedToUserId", "assignedByUserId", "assignedAt", "assignmentVersion" FROM calculation_notes WHERE id = :id`, { id: note.id });
    expect(row).toMatchObject({ assignedToUserId: A1.user.id, assignedByUserId: C.user.id, assignmentVersion: 1 });
    expect(row.assignedAt).toBeTruthy();
    expect(note.history.find((h) => h.action === "NOTE_ASSIGNED")).toMatchObject({ user: { id: C.user.id }, details: { from: null, to: A1.user.id, toEmail: A1.user.email } });

    await flushNotifications();
    const link = `/notes-calcul/detail?id=${note.id}`;
    const mails = await emailsOf(note.id);
    // Email à l'utilisateur affecté.
    const toA1 = mails.find((m) => m.to === A1.user.email);
    expect(toA1).toMatchObject({ subject: `Nouvelle note de calcul qui vous est affectée – ${note.reference}`, status: "SENT", type: "CALCULATION_NOTE_ASSIGNED" });
    for (const part of [
      `Bonjour ${names[A1.user.id]},`,
      "Une nouvelle note de calcul vous a été affectée.",
      `Référence : ${note.reference}`,
      `Projet : ${PROJECT.nomProjet}`,
      `Demandeur : ${names[R.user.id]}`,
      `Créateur : ${names[C.user.id]}`,
      "Date de création : ",
      "Observations générales : Vérifier la dalle R+1",
      "Documents techniques : calcul.pdf — Commentaire 1 ; plan.pdf — Commentaire 2",
      "Vous avez été désigné comme utilisateur responsable de cette note de calcul. Merci de consulter les informations et les documents associés.",
      link,
    ]) {
      expect(toA1.text).toContain(part);
    }
    // Demande de validation au validateur officiel.
    const toV = mails.find((m) => m.to === "medwethekgc@gmail.com");
    expect(toV).toMatchObject({ subject: `Nouvelle demande de validation – Note de calcul ${note.reference}`, status: "SENT", type: "CALCULATION_NOTE_PENDING" });
    for (const part of [
      "Une nouvelle note de calcul a été créée et nécessite votre validation. Veuillez consulter les informations et les documents associés, puis valider ou refuser la demande.",
      `Référence : ${note.reference}`,
      `Utilisateur affecté : ${names[A1.user.id]} (${A1.user.email})`,
      "Documents techniques : calcul.pdf — Commentaire 1",
      `Ouvrir la page de validation : `,
      link,
    ]) {
      expect(toV.text).toContain(part);
    }
    expect(mails).toHaveLength(2); // aucun doublon
    expect((await notificationsOf(note.id)).map((n) => [n.userId, n.type]).sort()).toEqual(
      [
        [A1.user.id, "CALCULATION_NOTE_ASSIGNED"],
        [V.user.id, "CALCULATION_NOTE_PENDING"],
      ].sort()
    );
    // L'affecté consulte la note (sans droit d'écriture ni de décision).
    const seen = await request(app).get(`/calculation-notes/${note.id}`).set(A1.auth);
    expect(seen.status).toBe(200);
    expect(seen.body.data).toMatchObject({ canEdit: false, canDecide: false, canAssign: false });
  });

  test("6. changements d'affectation historisés ; nouvel et ancien utilisateurs informés", async () => {
    const ch = await request(app).put(`/calculation-notes/${note.id}/assignment`).set(C.auth).send({ assignedToUserId: A2.user.id });
    expect(ch.status).toBe(200);
    expect(ch.body.data.assignedTo.id).toBe(A2.user.id);
    // Même valeur : aucun nouvel événement.
    await request(app).put(`/calculation-notes/${note.id}/assignment`).set(C.auth).send({ assignedToUserId: A2.user.id });
    const removed = await request(app).put(`/calculation-notes/${note.id}/assignment`).set(C.auth).send({ assignedToUserId: null });
    expect(removed.body.data.assignedTo).toBeNull();

    const hist = await request(app).get(`/calculation-notes/${note.id}/assignments`).set(R.auth);
    expect(hist.body.data.map((h) => [h.action, h.from?.id || null, h.to?.id || null, h.by.id])).toEqual([
      ["ASSIGNMENT_REMOVED", A2.user.id, null, C.user.id],
      ["ASSIGNMENT_CHANGED", A1.user.id, A2.user.id, C.user.id],
      ["NOTE_ASSIGNED", null, A1.user.id, C.user.id],
    ]);
    expect(hist.body.data.every((h) => h.createdAt)).toBe(true);

    await flushNotifications();
    const mails = await emailsOf(note.id);
    expect(mails.find((m) => m.to === A2.user.email && m.type === "CALCULATION_NOTE_ASSIGNED").subject).toBe(`Nouvelle note de calcul qui vous est affectée – ${note.reference}`);
    const unassigned = mails.filter((m) => m.type === "CALCULATION_NOTE_UNASSIGNED");
    expect(unassigned.map((m) => m.to).sort()).toEqual([A1.user.email, A2.user.email].sort());
    expect(unassigned.find((m) => m.to === A1.user.email).subject).toBe(`Affectation retirée – Note de calcul ${note.reference}`);
    expect(mails.filter((m) => m.type === "CALCULATION_NOTE_ASSIGNED")).toHaveLength(2); // A1 puis A2, sans doublon
    // A2 n'est plus affecté : il ne voit plus la note (aucun autre lien).
    expect((await request(app).get(`/calculation-notes/${note.id}`).set(A2.auth)).status).toBe(404);
  });

  test("8. non autorisés : affectation et validation refusées ; affectés invalides refusés", async () => {
    const res = await create(C.auth, { assignedToUserId: A1.user.id });
    const id = res.body.data.id;
    for (const [who, auth, status, code] of [
      ["affecté", A1.auth, 403, "PERMISSION_DENIED"],
      ["demandeur", R.auth, 403, "PERMISSION_DENIED"],
      ["validateur", V.auth, 403, "PERMISSION_DENIED"],
      ["sans lien", O.auth, 404, "NOT_FOUND"],
    ]) {
      const r = await request(app).put(`/calculation-notes/${id}/assignment`).set(auth).send({ assignedToUserId: A2.user.id });
      expect([who, r.status, r.body.code]).toEqual([who, status, code]);
    }
    if (BACKOFFICE) {
      const r = await request(app).put(`/calculation-notes/${id}/assignment`).set(BACKOFFICE).send({ assignedToUserId: A2.user.id });
      expect([r.status, r.body.code]).toEqual([403, "READ_ONLY_ACCOUNT"]);
    }
    for (const who of [A1, R]) {
      const r = await request(app).post(`/calculation-notes/${id}/validate`).set(who.auth).send({});
      expect([r.status, r.body.code]).toEqual([403, "NOT_VALIDATOR"]);
    }
    // Affectés hors liste autorisée.
    const invalid = await sql(`SELECT id FROM users WHERE role IN ('accueil','backoffice_readonly','responsable_logistique_achat') LIMIT 3`);
    for (const u of [...invalid, { id: "00000000-0000-4000-8000-000000000000" }]) {
      const r = await request(app).put(`/calculation-notes/${id}/assignment`).set(C.auth).send({ assignedToUserId: u.id });
      expect([r.status, r.body.code]).toEqual([400, "ASSIGNEE_INVALID"]);
    }
    const [row] = await sql(`SELECT "assignedToUserId" FROM calculation_notes WHERE id = :id`, { id });
    expect(row.assignedToUserId).toBe(A1.user.id);

    // Décision : l'affecté est notifié ; ensuite l'affectation est verrouillée
    // et l'historique de validation reste intact.
    expect((await request(app).post(`/calculation-notes/${id}/validate`).set(V.auth).send({})).status).toBe(200);
    await flushNotifications();
    expect((await notificationsOf(id)).filter((n) => n.type === "CALCULATION_NOTE_VALIDATED").map((n) => n.userId)).toContain(A1.user.id);
    expect((await emailsOf(id)).some((m) => m.to === A1.user.email && m.type === "CALCULATION_NOTE_VALIDATED")).toBe(true);
    const locked = await request(app).put(`/calculation-notes/${id}/assignment`).set(C.auth).send({ assignedToUserId: A2.user.id });
    expect([locked.status, locked.body.code]).toEqual([409, "NOTE_LOCKED"]);
    const h = await request(app).get(`/calculation-notes/${id}/history`).set(C.auth);
    expect(h.body.data[0]).toMatchObject({ action: "NOTE_VALIDATED", user: { id: V.user.id } });
  });

  test("7. SMTP indisponible : note créée, emails conservés et retentés ; échec définitif relancé sans doublon", async () => {
    // Serveur injoignable pour tous les envois de cette création.
    mailer.sendMail.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:587"), { code: "ECONNREFUSED" }));
    const res = await create(C.auth, { assignedToUserId: A1.user.id });
    expect(res.status).toBe(201); // jamais bloquant
    const id = res.body.data.id;
    await flushNotifications();
    let mails = await emailsOf(id);
    expect(mails.map((m) => m.to).sort()).toEqual([A1.user.email, "medwethekgc@gmail.com"].sort());
    for (const m of mails) {
      expect(m).toMatchObject({ status: "RETRYING", attempts: 1 });
      expect(m.lastErrorMessage).toContain("ECONNREFUSED");
      expect(m.nextAttemptAt).toBeTruthy(); // nouvelle tentative programmée
    }
    // Notifications internes enregistrées malgré la panne.
    expect((await notificationsOf(id)).map((n) => n.type).sort()).toEqual(["CALCULATION_NOTE_ASSIGNED", "CALCULATION_NOTE_PENDING"]);
    for (const m of mails) await cancelJob(m.id, "test"); // pas d'attente de 30 s ici

    // Refus définitif du serveur → FAILED, visible et relançable.
    mailer.sendMail.mockRejectedValue(Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 }));
    const ch = await request(app).put(`/calculation-notes/${id}/assignment`).set(C.auth).send({ assignedToUserId: A2.user.id });
    expect(ch.status).toBe(200);
    await flushNotifications();
    const status = await request(app).get(`/calculation-notes/${id}/email-notifications`).set(C.auth);
    const failed = status.body.data.filter((m) => m.status === "FAILED");
    expect(failed.map((m) => m.to).sort()).toEqual([A1.user.email, A2.user.email].sort()); // retrait + nouvelle affectation
    expect(failed[0].lastErrorMessage).toContain("550");

    // Relance : réservée au créateur / validateur / éditeurs.
    expect((await request(app).post(`/calculation-notes/${id}/email-notifications/resend`).set(R.auth).send({})).status).toBe(403);
    expect((await request(app).post(`/calculation-notes/${id}/email-notifications/resend`).set(O.auth).send({})).status).toBe(404);
    mailer.sendMail.mockResolvedValue({ messageId: "ok" });
    const resend = await request(app).post(`/calculation-notes/${id}/email-notifications/resend`).set(C.auth).send({});
    expect(resend.status).toBe(200);
    expect(resend.body.data.retried).toBe(2);
    mails = await emailsOf(id);
    for (const f of failed) expect(mails.find((m) => m.id === f.id).status).toBe("SENT");
    expect(mails.filter((m) => m.to === A2.user.email && m.type === "CALCULATION_NOTE_ASSIGNED")).toHaveLength(1); // aucun doublon

    // Les autres modules : comportement inchangé (panne de connexion = échec sans retentative).
    mailer.sendMail.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const key = `test-other-module-${Date.now()}`;
    const other = await enqueueEmailOnce({ dedupeKey: key, to: "nobody@example.com", subject: "x", text: "x", context: "test-other-module" });
    expect(other.status).toBe("FAILED");
    await sql(`DELETE FROM email_queue WHERE "dedupeKey" = :key`, { key });
  });

  test("affectation obligatoire si la règle est activée (CALCULATION_NOTE_ASSIGNEE_REQUIRED)", async () => {
    process.env.CALCULATION_NOTE_ASSIGNEE_REQUIRED = "true";
    try {
      const r = await create(C.auth, {});
      expect([r.status, r.body.code]).toEqual([400, "ASSIGNEE_REQUIRED"]);
      expect((await request(app).get("/calculation-notes/options").set(C.auth)).body.data.assigneeRequired).toBe(true);
      const ok = await create(C.auth, { assignedToUserId: A2.user.id });
      expect(ok.status).toBe(201);
      const rm = await request(app).put(`/calculation-notes/${ok.body.data.id}/assignment`).set(C.auth).send({ assignedToUserId: null });
      expect([rm.status, rm.body.code]).toEqual([400, "ASSIGNEE_REQUIRED"]);
    } finally {
      delete process.env.CALCULATION_NOTE_ASSIGNEE_REQUIRED;
    }
    // Par défaut : facultative.
    const free = await create(C.auth, {});
    expect(free.status).toBe(201);
    expect(free.body.data.assignedTo).toBeNull();
  });
});
