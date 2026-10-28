"use strict";

// Bout en bout, BASE RÉELLE, comptes réels : production_1 (Matin) crée une
// fiche PROMESH, production_2 (Soir) une fiche PROBAR — « En attente de
// validation » dès la création ; le responsable logistique les voit, valide,
// refuse (motif obligatoire) ; production_2 corrige et soumet de nouveau.
// Tentatives non autorisées (production_1, production_3, superadmin)
// refusées par le backend. Vraie application Express (auth,
// moduleAccessGuard, requireRole, routes).
//
// Le contrôle des dates de production (production-compliance, testé par
// ailleurs) est désactivé ici par son interrupteur existant pour ne pas
// dépendre de l'historique réel des fiches. Toutes les données créées sont
// supprimées en afterAll et la numérotation PROMESH restaurée ; les fiches
// existantes ne sont jamais modifiées (vérifié).

process.env.PRODUCTION_COMPLIANCE_ENABLED = "false";

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test", accepted: [], rejected: [], response: "250 OK" }),
  verifyConnection: jest.fn().mockResolvedValue({ ok: true }),
  maskEmail: (e) => e,
}));
jest.mock("../src/services/emailQueue.service", () => ({
  ...jest.requireActual("../src/services/emailQueue.service"),
  enqueueEmailOnce: jest.fn().mockResolvedValue({ jobId: null, status: "MOCK", duplicate: false }),
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));
jest.mock("../src/cron/ficheAutoValidation.job", () => ({}));
jest.mock("../src/cron/productionCompliance.job", () => ({}));
jest.mock("../src/cron/productionFollowUp.job", () => ({}));

const request = require("supertest");
const { Op, QueryTypes } = require("sequelize");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const { signAccessToken } = require("../src/utils/tokens");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const PorPromesh = require("../src/models/PorPromesh");
const IndustrialRecord = require("../src/models/IndustrialRecord");
const History = require("../src/models/ProductionFicheApprovalHistory");
const ficheApproval = require("../src/modules/production-fiche-approvals/services/ficheApproval.service");
const { enqueueEmailOnce } = require("../src/services/emailQueue.service");
const rawCfg = require("../src/config/rawMaterialRequest");

const EMAILS = {
  prod1: "production_1@cbi-tunisia.com",
  prod2: "production_2@cbi-tunisia.com",
  prod3: "production_3@cbi-tunisia.com",
  validator: "responsable_logistique@cbi-tunisia.com",
  superadmin: "cbitunisia@cbi-tunisia.com",
};
const TODAY = "2026-10-26";
const START = new Date();

const users = {};
const created = { promesh: [], probar: [] };
let seqBefore;
let snapshotBefore;

const token = (u) => `Bearer ${signAccessToken({ sub: u.id, email: u.email, role: u.role })}`;
const api = (method, path, who) => request(app)[method](path).set("Authorization", token(users[who]));

const PROBAR_BLOB = JSON.stringify({
  hd: "14:05",
  hf: "21:30",
  dia: "12",
  p: { r1: "Responsable E2E" },
  cq: [
    { heure: "15:00", nbBobines: "12", diametre: "12", poids: "15", longueurBarre: "6", longueurDechet: "0.4", statutCOQ: "OK" },
    { heure: "18:00", nbBobines: "", diametre: "", poids: "", longueurBarre: "", longueurDechet: "", statutCOQ: null },
  ],
});

async function snapshot() {
  const where = { createdAt: { [Op.lt]: START } };
  const p = await PorPromesh.findAll({ where, attributes: ["id", "status", "isLocked", "updatedAt", "approvalStatus"], raw: true });
  const i = await IndustrialRecord.findAll({ where, attributes: ["id", "statut", "updatedAt", "approvalStatus"], raw: true });
  return JSON.stringify([...p, ...i].sort((a, b) => a.id.localeCompare(b.id)));
}

async function createPromesh(who, poste = "matin") {
  const res = await api("post", "/por-promesh/new", who).send({ machine: "1", poste, dateProduction: TODAY });
  if (res.body?.data?.id) created.promesh.push(res.body.data.id);
  return res;
}

async function createProbar(who, poste = "nuit") {
  const res = await api("post", "/industrial-records", who).send({
    module: "probar",
    machine: "2",
    poste,
    dateFiche: TODAY,
    quantiteProduite: 150,
    description: PROBAR_BLOB,
    observations: "Fiche E2E",
    statut: "enregistree",
  });
  if (res.body?.data?.id) created.probar.push(res.body.data.id);
  return res;
}

const dbFiche = (type, id) => (type === "promesh" ? PorPromesh : IndustrialRecord).findByPk(id, { raw: true });

beforeAll(async () => {
  // Jour sans demande de matières premières obligatoire (lundi) : ce test ne
  // dépend pas de l'autre circuit.
  rawCfg.clock = () => new Date("2026-10-26T13:00:00Z");
  for (const [k, email] of Object.entries(EMAILS)) {
    const u = await User.findOne({ where: { email }, attributes: ["id", "email", "role"] });
    if (!u) throw new Error(`Compte introuvable en base : ${email}`);
    users[k] = { id: u.id, email: u.email, role: u.role };
  }
  // Rôle partagé : la validation est nominative.
  for (const k of ["prod1", "prod2", "prod3", "validator"]) expect(users[k].role).toBe("responsable_logistique_achat");
  const [s] = await sequelize.query(`SELECT last_value, is_called FROM "por_promesh_sequenceNumber_seq"`, { type: QueryTypes.SELECT });
  seqBefore = s;
  snapshotBefore = await snapshot();
});

afterAll(async () => {
  rawCfg.clock = () => new Date();
  const ids = [...created.promesh, ...created.probar];
  if (ids.length) {
    await History.destroy({ where: { ficheId: ids } });
    for (const t of ["por_promesh_controle_qualite", "por_promesh_arret_machine", "por_promesh_consommation", "por_promesh_process_control", "por_promesh_non_conformite", "por_promesh_attachments"]) {
      await sequelize.query(`DELETE FROM ${t} WHERE "porPromeshId" IN (:ids)`, { replacements: { ids } }).catch(() => {});
    }
    await PorPromesh.destroy({ where: { id: created.promesh } });
    await IndustrialRecord.destroy({ where: { id: created.probar } });
  }
  // Uniquement les notifications des fiches de ce test (jamais celles des fiches réelles).
  if (ids.length) await Notification.destroy({ where: { productionFicheId: ids } });
  // Numérotation : jamais en dessous d'une fiche réelle créée pendant le test.
  const [{ m }] = await sequelize.query(`SELECT COALESCE(MAX("sequenceNumber"), 0) AS m FROM por_promesh`, { type: QueryTypes.SELECT });
  const restore = Math.max(Number(seqBefore.last_value), Number(m));
  await sequelize.query(`SELECT setval('"por_promesh_sequenceNumber_seq"', :v, :called)`, {
    replacements: { v: restore, called: restore === Number(seqBefore.last_value) ? seqBefore.is_called : true },
  });
  // Fiches existantes (historiques ou réelles du circuit) : inchangées.
  expect(await snapshot()).toBe(snapshotBefore);
  await sequelize.close();
});

describe("Création : « En attente de validation » dès la création (deux comptes de production)", () => {
  test("production_1 (Matin) crée une fiche PROMESH", async () => {
    const res = await createPromesh("prod1", "matin");
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("BROUILLON"); // cycle de saisie existant inchangé
    const fiche = await api("get", `/por-promesh/${res.body.data.id}`, "prod1");
    expect(fiche.body.data.approval).toMatchObject({ status: "PENDING", label: "En attente de validation", version: 1, decidedAt: null });
    expect((await dbFiche("promesh", res.body.data.id)).approvalSubmittedAt).toBeInstanceOf(Date);
  });

  test("production_2 (Soir) crée une fiche PROBAR", async () => {
    const res = await createProbar("prod2", "nuit");
    expect(res.status).toBe(201);
    expect(res.body.data.statut).toBe("enregistree");
    expect(res.body.data.approval).toMatchObject({ status: "PENDING", version: 1 });
    const db = await dbFiche("probar", res.body.data.id);
    expect(db.approvalStatus).toBe("PENDING");
    expect(Number(db.quantiteProduite)).toBe(150); // données saisies conservées
  });

  test("une fiche du responsable logistique (ou d'un autre compte) reste hors circuit", async () => {
    const res = await createPromesh("validator");
    expect(res.status).toBe(201);
    expect((await dbFiche("promesh", res.body.data.id)).approvalStatus).toBeNull();
    const p3 = await createProbar("prod3", "matin");
    expect(p3.status).toBe(201);
    expect(p3.body.data.approval).toBeNull();
  });
});

describe("Responsable logistique : visibilité immédiate et décisions", () => {
  const promeshId = () => created.promesh[0];
  const probarId = () => created.probar[0];

  test("les deux fiches sont visibles immédiatement, avec détails et historique", async () => {
    const list = await api("get", "/production-fiche-approvals?status=PENDING", "validator");
    expect(list.status).toBe(200);
    const mine = list.body.data.filter((i) => [promeshId(), probarId()].includes(i.id));
    expect(mine).toHaveLength(2);
    const promesh = mine.find((i) => i.ficheType === "promesh");
    expect(promesh).toMatchObject({ creatorEmail: EMAILS.prod1, poste: "matin", posteLabel: "Matin", machine: "1", status: "PENDING", statusLabel: "En attente de validation" });
    expect(promesh.numero).toMatch(/^PROMESH-2026-\d{6}$/);
    const probar = mine.find((i) => i.ficheType === "probar");
    expect(probar).toMatchObject({ creatorEmail: EMAILS.prod2, posteLabel: "Soir", production: { value: 150 } });
    expect(probar.dechets).toEqual([{ label: "Longueur déchet (15:00)", value: 0.4 }]);

    const sum = await api("get", "/production-fiche-approvals/summary", "validator");
    expect(sum.body.data.pending).toBeGreaterThanOrEqual(2);

    const detail = await api("get", `/production-fiche-approvals/probar/${probarId()}`, "validator");
    expect(detail.status).toBe(200);
    expect(detail.body.data.canDecide).toBe(true);
    const titles = detail.body.data.details.sections.map((s) => s.title);
    expect(titles).toEqual(expect.arrayContaining(["Informations générales", "Dimensions", "Quantités produites"]));
    const cq = detail.body.data.details.tables.find((t) => t.title.startsWith("Contrôle qualité"));
    expect(cq.rows).toHaveLength(1); // créneau vide non affiché
    expect(detail.body.data.history).toEqual([expect.objectContaining({ version: 1, fromStatus: null, toStatus: "PENDING", changedByEmail: EMAILS.prod2 })]);
  });

  test("permissions : seul le responsable logistique peut décider", async () => {
    const perms = await api("get", "/production-fiche-approvals/permissions", "validator");
    expect(perms.body.data).toMatchObject({ canDecide: true, canViewAll: true });
    const p1 = await api("get", "/production-fiche-approvals/permissions", "prod1");
    expect(p1.body.data).toMatchObject({ canDecide: false, canViewAll: false, isCreator: true });
    const p3 = await api("get", "/production-fiche-approvals/permissions", "prod3");
    expect(p3.body.data.canView).toBe(false);
  });

  test("tentatives d'approbation non autorisées : refusées par le backend, fiche toujours en attente", async () => {
    for (const who of ["prod1", "prod2", "prod3", "superadmin"]) {
      const res = await api("post", `/production-fiche-approvals/promesh/${promeshId()}/approve`, who).send({});
      expect(res.status).toBe(403);
      const rej = await api("post", `/production-fiche-approvals/probar/${probarId()}/reject`, who).send({ comment: "non" });
      expect(rej.status).toBe(403);
    }
    expect((await dbFiche("promesh", promeshId())).approvalStatus).toBe("PENDING");
    expect((await dbFiche("probar", probarId())).approvalStatus).toBe("PENDING");
  });

  test("les comptes de production ne voient que leurs propres fiches", async () => {
    const list = await api("get", "/production-fiche-approvals?status=all", "prod1");
    expect(list.status).toBe(200);
    expect(list.body.data.every((i) => i.creatorEmail === EMAILS.prod1)).toBe(true);
    const other = await api("get", `/production-fiche-approvals/probar/${probarId()}`, "prod1");
    expect(other.status).toBe(403);
    const p3 = await api("get", "/production-fiche-approvals", "prod3");
    expect(p3.status).toBe(403);
  });

  test("refus sans motif : bloqué, la fiche reste en attente", async () => {
    for (const comment of [undefined, "", "   "]) {
      const res = await api("post", `/production-fiche-approvals/probar/${probarId()}/reject`, "validator").send(comment === undefined ? {} : { comment });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("REJECTION_COMMENT_REQUIRED");
    }
    const db = await dbFiche("probar", probarId());
    expect(db.approvalStatus).toBe("PENDING");
    expect(db.approvalRejectionComment).toBeNull();
  });

  test("fiche modifiée depuis son affichage : décision refusée (aucune décision sur une version périmée)", async () => {
    const before = await api("get", `/production-fiche-approvals/promesh/${promeshId()}`, "validator");
    const seenAt = before.body.data.updatedAt;
    await new Promise((r) => setTimeout(r, 15));
    const upd = await api("put", `/por-promesh/${promeshId()}`, "prod1").send({ productionM2: 320, diametreMaille1: "5", totalChuteBarres: 4 });
    expect(upd.status).toBe(200);
    const res = await api("post", `/production-fiche-approvals/promesh/${promeshId()}/approve`, "validator").send({ version: 1, ficheUpdatedAt: seenAt });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FICHE_MODIFIED");
    expect((await dbFiche("promesh", promeshId())).approvalStatus).toBe("PENDING");
  });

  test("validation : « Validée » côté responsable et côté production, avec auteur et date", async () => {
    const seen = await api("get", `/production-fiche-approvals/promesh/${promeshId()}`, "validator");
    const res = await api("post", `/production-fiche-approvals/promesh/${promeshId()}/approve`, "validator").send({
      version: seen.body.data.version,
      ficheUpdatedAt: seen.body.data.updatedAt,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "APPROVED", statusLabel: "Validée", decidedByEmail: EMAILS.validator });

    const db = await dbFiche("promesh", promeshId());
    expect(db).toMatchObject({ approvalStatus: "APPROVED", approvalDecidedBy: users.validator.id, approvalDecidedByEmail: EMAILS.validator });
    expect(db.approvalDecidedAt).toBeInstanceOf(Date);
    expect(db.status).toBe("BROUILLON"); // la décision ne touche pas au cycle de saisie
    expect(Number(db.productionM2)).toBe(320);

    // Retirée de la liste « en attente ».
    const pending = await api("get", "/production-fiche-approvals?status=PENDING", "validator");
    expect(pending.body.data.some((i) => i.id === promeshId())).toBe(false);

    // Côté production_1 : la fiche elle-même et la liste.
    const fiche = await api("get", `/por-promesh/${promeshId()}`, "prod1");
    expect(fiche.body.data.approval).toMatchObject({ status: "APPROVED", label: "Validée", decidedByEmail: EMAILS.validator });
    const notif = await Notification.findOne({ where: { userId: users.prod1.id, type: "PRODUCTION_FICHE_APPROVED", createdAt: { [Op.gte]: START } } });
    expect(notif).not.toBeNull();
  });

  test("double validation et décision contradictoire : refusées", async () => {
    const again = await api("post", `/production-fiche-approvals/promesh/${promeshId()}/approve`, "validator").send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_DECIDED");
    const contra = await api("post", `/production-fiche-approvals/promesh/${promeshId()}/reject`, "validator").send({ comment: "Trop tard" });
    expect(contra.status).toBe(409);
    expect((await dbFiche("promesh", promeshId())).approvalStatus).toBe("APPROVED");
    const hist = await History.count({ where: { ficheId: promeshId() } });
    expect(hist).toBe(2);
  });

  test("décisions simultanées : une seule aboutit", async () => {
    const res = await createPromesh("prod1", "matin");
    const id = res.body.data.id;
    const [a, b] = await Promise.all([
      api("post", `/production-fiche-approvals/promesh/${id}/approve`, "validator").send({}),
      api("post", `/production-fiche-approvals/promesh/${id}/reject`, "validator").send({ comment: "Contradictoire" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await History.count({ where: { ficheId: id, fromStatus: "PENDING" } })).toBe(1);
  });

  test("refus avec motif : « Refusée » et motif visible côté production", async () => {
    const motif = "Diamètre non conforme au bon de commande";
    const res = await api("post", `/production-fiche-approvals/probar/${probarId()}/reject`, "validator").send({ comment: `  ${motif}  ` });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "REJECTED", statusLabel: "Refusée", rejectionComment: motif });

    const db = await dbFiche("probar", probarId());
    expect(db).toMatchObject({ approvalStatus: "REJECTED", approvalRejectionComment: motif, approvalDecidedBy: users.validator.id });
    expect(db.approvalRejectedAt).toBeInstanceOf(Date);
    expect(db.statut).toBe("enregistree");

    const fiche = await api("get", `/industrial-records/${probarId()}`, "prod2");
    expect(fiche.body.data.approval).toMatchObject({ status: "REJECTED", rejectionComment: motif });
    expect(fiche.body.data.approval.rejectedAt).toBeTruthy();
    const notif = await Notification.findOne({ where: { userId: users.prod2.id, type: "PRODUCTION_FICHE_REJECTED", createdAt: { [Op.gte]: START } } });
    expect(notif.message).toContain(`Motif : ${motif}`);
  });

  test("reconnexion (nouveaux jetons) : statuts et motifs toujours présents", async () => {
    const p1 = await api("get", "/production-fiche-approvals?status=all", "prod1");
    expect(p1.body.data.find((i) => i.id === promeshId()).status).toBe("APPROVED");
    const p2 = await api("get", `/production-fiche-approvals/probar/${probarId()}`, "prod2");
    expect(p2.body.data).toMatchObject({ status: "REJECTED", rejectionComment: "Diamètre non conforme au bon de commande", canResubmit: true, canDecide: false });
    const v = await api("get", "/production-fiche-approvals?status=REJECTED", "validator");
    expect(v.body.data.some((i) => i.id === probarId())).toBe(true);
  });

  test("correction puis nouvelle soumission : ancienne décision conservée, nouvelle trace", async () => {
    // Seul le créateur peut soumettre de nouveau.
    expect((await api("post", `/production-fiche-approvals/probar/${probarId()}/resubmit`, "prod1").send({})).status).toBe(403);
    expect((await api("post", `/production-fiche-approvals/probar/${probarId()}/resubmit`, "validator").send({})).status).toBe(403);

    const upd = await api("put", `/industrial-records/${probarId()}`, "prod2").send({ quantiteProduite: 160 });
    expect(upd.status).toBe(200);
    const res = await api("post", `/production-fiche-approvals/probar/${probarId()}/resubmit`, "prod2").send({ comment: "Diamètre corrigé" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "PENDING", version: 2, decidedAt: null, rejectionComment: "Diamètre non conforme au bon de commande" });
    expect((await api("post", `/production-fiche-approvals/probar/${probarId()}/resubmit`, "prod2").send({})).status).toBe(409);

    // Décision sur l'ancienne soumission : refusée.
    const stale = await api("post", `/production-fiche-approvals/probar/${probarId()}/approve`, "validator").send({ version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_MISMATCH");
    const ok = await api("post", `/production-fiche-approvals/probar/${probarId()}/approve`, "validator").send({ version: 2 });
    expect(ok.status).toBe(200);

    const hist = (await api("get", `/production-fiche-approvals/probar/${probarId()}`, "prod2")).body.data.history;
    expect(hist.map((h) => [h.version, h.fromStatus, h.toStatus])).toEqual([
      [1, null, "PENDING"],
      [1, "PENDING", "REJECTED"],
      [2, "REJECTED", "PENDING"],
      [2, "PENDING", "APPROVED"],
    ]);
    expect(hist[1].comment).toBe("Diamètre non conforme au bon de commande");
    expect(hist[1].changedByEmail).toBe(EMAILS.validator);
  });
});

describe("Fiche PROMESH verrouillée puis refusée : correction possible par son créateur uniquement", () => {
  test("verrou existant conservé, sauf pour corriger une fiche refusée", async () => {
    const res = await createPromesh("prod1", "matin");
    const id = res.body.data.id;
    expect((await api("post", `/por-promesh/${id}/validate`, "prod1")).status).toBe(200); // « Terminer la saisie »
    const locked = await api("put", `/por-promesh/${id}`, "prod1").send({ productionM2: 10 });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("SHEET_LOCKED");

    // « Saisie terminée » n'est pas une validation par le responsable.
    expect((await dbFiche("promesh", id)).approvalStatus).toBe("PENDING");

    await api("post", `/production-fiche-approvals/promesh/${id}/reject`, "validator").send({ comment: "Production à recompter" });
    const fixed = await api("put", `/por-promesh/${id}`, "prod1").send({ productionM2: 12 });
    expect(fixed.status).toBe(200);
    const db = await dbFiche("promesh", id);
    expect(db).toMatchObject({ status: "VALIDE", isLocked: true, approvalStatus: "REJECTED" });
    expect(Number(db.productionM2)).toBe(12);

    // Fiche validée : le verrou s'applique de nouveau après la décision.
    await api("post", `/production-fiche-approvals/promesh/${id}/resubmit`, "prod1").send({});
    await api("post", `/production-fiche-approvals/promesh/${id}/approve`, "validator").send({});
    expect((await api("put", `/por-promesh/${id}`, "prod1").send({ productionM2: 99 })).status).toBe(403);
  });
});

describe("Notifications du responsable logistique et historique des validations", () => {
  const promeshId = () => created.promesh[0];
  const probarId = () => created.probar[0];
  const pendingFor = (id) =>
    Notification.findAll({ where: { userId: users.validator.id, type: "PRODUCTION_FICHE_PENDING", productionFicheId: id }, order: [["productionFicheVersion", "ASC"]] });

  test("PROD1 crée une fiche : le responsable reçoit une notification complète, liée à la fiche, et un email interne", async () => {
    const [n] = await pendingFor(promeshId());
    expect(n).toBeDefined();
    expect(n).toMatchObject({ productionFicheType: "promesh", productionFicheVersion: 1, title: "Nouvelle fiche de production à valider" });
    const fiche = await PorPromesh.findByPk(promeshId(), { raw: true });
    const numero = `PROMESH-${new Date(fiche.createdAt).getFullYear()}-${String(fiche.sequenceNumber).padStart(6, "0")}`;
    for (const part of [`Fiche : ${numero}`, "Type de production : PROMESH", "Machine : 1", "Date de production : 26/10/2026", "Poste : Matin", `Producteur : ${EMAILS.prod1}`, "Créée le : ", "Statut : En attente de validation"]) {
      expect(n.message).toContain(part);
    }
    // Un email interne par responsable (logistique et production, s'ils existent en base).
    const mails = enqueueEmailOnce.mock.calls.map(([a]) => a).filter((a) => a.meta?.ficheId === promeshId());
    const mail = mails.find((a) => a.to === EMAILS.validator);
    expect(mail).toMatchObject({ to: EMAILS.validator, dedupeKey: `production-fiche-approval:pending:promesh:${promeshId()}:v1:${EMAILS.validator}` });
    expect(new Set(mails.map((a) => a.to)).size).toBe(mails.length);
    expect(mail.html).toContain(`/production/validation-fiches?fiche=promesh:${promeshId()}`);
  });

  test("PROD2 crée une fiche : le responsable reçoit une notification (poste Soir)", async () => {
    const list = await pendingFor(probarId());
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].message).toContain("Type de production : PROBAR");
    expect(list[0].message).toContain("Poste : Soir");
    expect(list[0].message).toContain(`Producteur : ${EMAILS.prod2}`);
  });

  test("le centre de notifications du responsable renvoie la fiche à ouvrir", async () => {
    const res = await api("get", "/notifications?limit=50", "validator");
    expect(res.status).toBe(200);
    const item = res.body.items.find((i) => i.productionFicheId === promeshId());
    expect(item).toMatchObject({ type: "PRODUCTION_FICHE_PENDING", productionFicheType: "promesh" });
  });

  test("nouvelle tentative : aucune notification ni email en double", async () => {
    const before = enqueueEmailOnce.mock.calls.length;
    const fiche = await PorPromesh.findByPk(promeshId());
    await ficheApproval.notifyCreated("promesh", fiche);
    await ficheApproval.notifyCreated("promesh", fiche);
    expect(await pendingFor(promeshId())).toHaveLength(1);
    // Emails : même clé de dédoublonnage (la file refuse les doublons en base).
    const calls = enqueueEmailOnce.mock.calls.slice(before).map(([a]) => a);
    // Une clé par responsable destinataire, toujours la même à chaque tentative.
    const expected = new Set(calls.map((a) => `production-fiche-approval:pending:promesh:${promeshId()}:v1:${a.to}`));
    expect(new Set(calls.map((a) => a.dedupeKey))).toEqual(expected);
    expect(expected.has(`production-fiche-approval:pending:promesh:${promeshId()}:v1:${EMAILS.validator}`)).toBe(true);
    // Contrainte en base : un second enregistrement identique est refusé.
    await expect(
      Notification.create({ userId: users.validator.id, type: "PRODUCTION_FICHE_PENDING", title: "x", message: "x", productionFicheType: "promesh", productionFicheId: promeshId(), productionFicheVersion: 1 })
    ).rejects.toThrow();
  });

  test("nouvelle soumission : une notification par soumission (v1, v2), décisions notifiées au producteur avec la fiche", async () => {
    const versions = (await pendingFor(probarId())).map((n) => n.productionFicheVersion);
    expect(versions).toEqual([1, 2]);
    const decided = await Notification.findAll({ where: { userId: users.prod2.id, productionFicheId: probarId() }, order: [["createdAt", "ASC"]] });
    expect(decided.map((n) => [n.type, n.productionFicheVersion])).toEqual([
      ["PRODUCTION_FICHE_REJECTED", 1],
      ["PRODUCTION_FICHE_APPROVED", 2],
    ]);
    expect(decided[0].message).toContain("Motif : Diamètre non conforme au bon de commande");
  });

  test("historique : décisions conservées et filtrables (période, producteur, type, machine, poste, statut)", async () => {
    const q = (qs) => api("get", `/production-fiche-approvals?${qs}`, "validator");
    const all = await q("status=all");
    const row = all.body.data.find((i) => i.id === probarId());
    expect(row).toMatchObject({ status: "APPROVED", decidedByEmail: EMAILS.validator, rejectionComment: "Diamètre non conforme au bon de commande", creatorEmail: EMAILS.prod2 });
    expect(row.decidedAt).toBeTruthy();
    expect(row.createdAt).toBeTruthy();

    const ids = (r) => r.body.data.map((i) => i.id);
    expect(ids(await q(`status=all&from=${TODAY}&to=${TODAY}&creator=${EMAILS.prod2}&type=probar&machine=2&poste=nuit`))).toContain(probarId());
    expect(ids(await q("status=all&type=promesh"))).not.toContain(probarId());
    expect(ids(await q("status=all&poste=matin"))).not.toContain(probarId());
    expect(ids(await q("status=all&machine=1"))).not.toContain(probarId());
    expect(ids(await q(`status=all&creator=${EMAILS.prod1}`))).not.toContain(probarId());
    expect(ids(await q("status=all&from=2026-10-27"))).not.toContain(probarId());
    expect(ids(await q("status=REJECTED"))).not.toContain(probarId());
    expect(ids(await q("status=PENDING"))).not.toContain(probarId());
    expect((await q("status=all&from=26-10-2026")).status).toBe(400);

    const perms = await api("get", "/production-fiche-approvals/permissions", "validator");
    expect(perms.body.data.creators).toEqual([EMAILS.prod1, EMAILS.prod2]);
  });

  test("compteurs (KPI) : mêmes filtres que la liste, jamais codés en dur ; recherche par validateur", async () => {
    const qs = `type=probar&creator=${EMAILS.prod2}&from=${TODAY}&to=${TODAY}&machine=2&poste=nuit`;
    const list = (await api("get", `/production-fiche-approvals?status=all&${qs}`, "validator")).body.data;
    const sum = await api("get", `/production-fiche-approvals/summary?${qs}`, "validator");
    expect(sum.status).toBe(200);
    const n = (s) => list.filter((i) => i.status === s).length;
    expect(sum.body.data).toEqual({ pending: n("PENDING"), approved: n("APPROVED"), rejected: n("REJECTED"), processed: n("APPROVED") + n("REJECTED") });
    expect(sum.body.data.approved).toBeGreaterThanOrEqual(1); // la fiche PROBAR acceptée de production_2
    // Le statut de l'historique ne change pas les compteurs.
    expect((await api("get", `/production-fiche-approvals/summary?${qs}&status=REJECTED`, "validator")).body.data).toEqual(sum.body.data);
    // Sans filtre : comptage global (badge du menu), avec le total des fiches traitées.
    const all = (await api("get", "/production-fiche-approvals/summary", "validator")).body.data;
    expect(all.processed).toBe(all.approved + all.rejected);
    // Producteur : uniquement ses propres fiches.
    const own = (await api("get", "/production-fiche-approvals?status=all", "prod1")).body.data;
    const ownSum = (await api("get", `/production-fiche-approvals/summary?from=2000-01-01`, "prod1")).body.data;
    expect(ownSum.pending + ownSum.processed).toBe(own.length);

    // Recherche par validateur : décisions de responsable_logistique, pas les fiches en attente.
    const found = (await api("get", `/production-fiche-approvals?status=all&search=${encodeURIComponent("responsable_logistique")}`, "validator")).body.data;
    expect(found.map((i) => i.id)).toContain(probarId());
    expect(found.every((i) => i.decidedByEmail === EMAILS.validator || String(i.creatorEmail).includes("responsable_logistique"))).toBe(true);
  });
});
