"use strict";

const { Op } = require("sequelize");
const { sequelize } = require("../../../db");
const { retryFailedJob } = require("../../../services/emailQueue.service");
const {
  User,
  UserProfile,
  Project,
  UserProject,
  CalculationNote,
  CalculationNoteDocument,
  CalculationNoteHistory,
} = require("../../../models/associations");
const { resolveFullName } = require("../../../utils/userDisplay");
const { storeFile, removeStoredFiles, resolveStoredPath, UploadRejected } = require("../middleware/calculationNoteUpload");
const wf = require("../../../config/calculationNoteValidation");
const backoffice = require("../../../config/backofficeReadOnly");
const notify = require("./calculationNoteNotify.service");

// ── Permissions ──────────────────────────────────────────────────────────
// Mêmes règles que les projets CRM (routes/projects.routes.js) :
//   - admin / superadmin / superadmin2 : toutes les notes, tous les projets ;
//   - autres rôles CRM : les notes des projets auxquels ils ont accès
//     (propriétaire du projet ou lien user_projects), plus celles qu'ils ont
//     créées ou demandées ;
//   - écriture : projet dont l'utilisateur est propriétaire ou « editor »
//     (même règle que les devis), ou note qu'il a lui-même créée.
//   - validation : seul le validateur enregistré sur la note (validatorId,
//     config/calculationNoteValidation.js) décide ; il lit les notes qui lui
//     sont soumises. Une note validée ou annulée n'est plus modifiable.
// Le compte back-office (backoffice_readonly) n'atteint jamais ces écritures :
// readOnlyRoleGuard les refuse (403) avant ce module ; ses lectures sont
// celles de son compte de référence.
const ADMIN_ROLES = ["admin", "superadmin", "superadmin2"];
// Rôles ayant accès au module (les rôles industriels / finance / qualité
// sont déjà bornés à leurs modules par moduleAccessGuard).
const MODULE_ROLES = ["user", "commercial", ...ADMIN_ROLES];
// « Affecter à » : comptes CRM actifs ayant accès au module (l'utilisateur
// affecté doit pouvoir ouvrir la note).
const ASSIGNEE_ROLES = MODULE_ROLES;
// Utilisateurs proposés comme « Demandeur » : comptes CRM actifs.
const REQUESTER_ROLES = ["user", "commercial", "accueil", ...ADMIN_ROLES];

const MAX_COMMENT = 4000;
const MAX_TITLE = 255;
// Types de document proposés (facultatif).
const DOCUMENT_TYPES = ["note_de_calcul", "plan", "hypotheses", "metre", "rapport", "annexe", "autre"];
const TZ_OFFSET = "+01:00"; // Africa/Tunis (UTC+1, sans heure d'été)

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isAdmin = (user) => ADMIN_ROLES.includes(user?.role);

// Compte back-office (backoffice_readonly) dans CE module :
//   - lectures : arrivent avec l'identité du compte de référence + `viewAs`
//     (middleware/readOnlyRoleGuard) — `viewAs` n'est posé que par ce garde,
//     dans un jeton signé par le serveur ;
//   - Valider / Refuser : arrivent avec son identité réelle (rôle).
// Vue GLOBALE sur toutes les notes (jamais limitée au compte de référence),
// décision possible, aucune autre écriture (refusée par le garde).
const isBackoffice = (user) => !!user?.viewAs || backoffice.isReadOnlyRole(user?.role);
// Identité RÉELLE de la personne connectée (« Mes notes », créateur, affecté).
const actorId = (user) => user?.viewAs || user?.sub;
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));

function tunisYear(date = new Date()) {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis", year: "numeric" }).format(date));
}

function formatReference(year, n) {
  return `NC-${year}-${String(n).padStart(4, "0")}`;
}

// Prochain numéro de l'année, DANS la transaction de création. L'upsert
// verrouille la ligne du compteur jusqu'au commit : deux créations
// simultanées sont sérialisées, aucune ne peut lire la même valeur. Le
// compteur ne fait que croître (un numéro n'est jamais réutilisé, même après
// suppression d'une note) ; si la transaction échoue, rien n'a été attribué.
async function nextReference(transaction, date = new Date()) {
  const year = tunisYear(date);
  const [rows] = await sequelize.query(
    `INSERT INTO calculation_note_counters (year, "lastValue", "updatedAt")
     VALUES (:year, 1, NOW())
     ON CONFLICT (year) DO UPDATE
       SET "lastValue" = calculation_note_counters."lastValue" + 1, "updatedAt" = NOW()
     RETURNING "lastValue"`,
    { replacements: { year }, transaction }
  );
  const sequenceNumber = Number(rows[0].lastValue);
  return { year, sequenceNumber, reference: formatReference(year, sequenceNumber) };
}

// Projets accessibles en lecture (sous-requête SQL) — null pour un admin.
function accessibleProjectsSql(user) {
  const me = sequelize.escape(user.sub);
  return `(SELECT p.id FROM projects p WHERE p."ownerId" = ${me}
           UNION SELECT up."projectId" FROM user_projects up WHERE up."userId" = ${me})`;
}

function readScope(user) {
  if (isAdmin(user) || isBackoffice(user)) return {};
  return {
    [Op.or]: [
      { createdBy: user.sub },
      { requesterId: user.sub },
      { validatorId: user.sub },
      { assignedToUserId: user.sub },
      { projectId: { [Op.in]: sequelize.literal(accessibleProjectsSql(user)) } },
    ],
  };
}

async function canWriteProject(user, project) {
  if (!project) return false;
  if (isAdmin(user)) return true;
  if (project.isArchived) return false;
  if (project.ownerId && project.ownerId === user.sub) return true;
  const link = await UserProject.findOne({ where: { userId: user.sub, projectId: project.id }, attributes: ["permission"] });
  return ["owner", "editor"].includes(link?.permission);
}

// Même règle que canEditNote, en SQL (une colonne par ligne de la liste).
function canEditSql(user) {
  if (isBackoffice(user)) return "false";
  const editable = `"CalculationNote"."status" IN (${wf.EDITABLE_STATUSES.map((x) => `'${x}'`).join(",")})`;
  if (isAdmin(user)) return editable;
  const me = sequelize.escape(user.sub);
  return `(${editable} AND ("CalculationNote"."createdBy" = ${me} OR EXISTS (
    SELECT 1 FROM projects p WHERE p.id = "CalculationNote"."projectId" AND COALESCE(p."isArchived", false) = false
      AND (p."ownerId" = ${me} OR EXISTS (SELECT 1 FROM user_projects up WHERE up."projectId" = p.id AND up."userId" = ${me} AND up.permission IN ('owner','editor'))))))`;
}

async function canEditNote(user, note, project) {
  if (isBackoffice(user)) return false; // consultation + décision uniquement
  if (!wf.EDITABLE_STATUSES.includes(note.status)) return false; // validée ou annulée : verrouillée
  if (isAdmin(user)) return true;
  if (note.createdBy === user.sub) return true;
  return canWriteProject(user, project);
}

// ── Sérialisation ────────────────────────────────────────────────────────
const userInclude = (as) => ({
  model: User,
  as,
  attributes: ["id", "email", "isActive", "role"],
  include: [{ model: UserProfile, as: "profile", attributes: ["name", "prenom", "nom"], required: false }],
});

const userDto = (u, { withRole = false } = {}) => (u ? { id: u.id, email: u.email, name: resolveFullName(u), ...(withRole ? { role: u.role } : {}) } : null);

function documentDto(d) {
  return {
    id: d.id,
    noteId: d.noteId,
    projectId: d.projectId,
    originalName: d.originalName,
    extension: d.extension,
    mimeType: d.mimeType,
    sizeBytes: Number(d.sizeBytes),
    commentaire: d.commentaire,
    title: d.title,
    documentType: d.documentType,
    origin: d.origin,
    uploadedBy: userDto(d.uploader),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function projectDto(p) {
  return p
    ? {
        id: p.id,
        nomProjet: p.nomProjet,
        statut: p.statut,
        projectModele: p.projectModele,
        entreprise: p.entreprise,
        adresse: p.adresse,
        isArchived: !!p.isArchived,
      }
    : null;
}

// Statut et décision ; can* = actions que le BACKEND autorisera à cet
// utilisateur (l'interface ne fait que les refléter).
function workflowDto(note, user) {
  const S = wf.STATUSES;
  return {
    status: note.status,
    statusLabel: wf.STATUS_LABELS[note.status] || note.status,
    submissionVersion: note.submissionVersion,
    submittedAt: note.submittedAt,
    validator: userDto(note.validator),
    decidedBy: userDto(note.decider),
    decidedAt: note.decidedAt,
    decisionComment: note.decisionComment,
    cancelledBy: userDto(note.canceller),
    cancelledAt: note.cancelledAt,
    cancellationReason: note.cancellationReason,
    assignedTo: userDto(note.assignee, { withRole: true }),
    assignedAt: note.assignedAt,
    assignedBy: userDto(note.assigner),
    // Validateur désigné, ou back-office (module Notes de calcul).
    canDecide: note.status === S.PENDING && ((!!note.validatorId && note.validatorId === user.sub) || isBackoffice(user)),
    canCancel: !isBackoffice(user) && wf.CANCELLABLE_STATUSES.includes(note.status) && note.createdBy === user.sub,
  };
}

// Validateur officiel : compte actif retrouvé par son adresse, utilisé ensuite
// par son ID. Jamais créé ni deviné : absent → création de note refusée.
async function resolveValidator() {
  const email = wf.validatorEmail();
  const u = await User.findOne({
    where: { [Op.and]: [sequelize.where(sequelize.fn("lower", sequelize.col("email")), email), { isActive: true }] },
    attributes: ["id", "email"],
  });
  if (!u) {
    throw new HttpError(503, "VALIDATOR_UNAVAILABLE", `Le validateur des notes de calcul (${email}) est introuvable ou inactif. Aucune note ne peut être transmise : contactez l'administrateur.`);
  }
  return u;
}

async function findAssignee(id) {
  if (!isUuid(id)) throw new HttpError(400, "ASSIGNEE_INVALID", "Utilisateur affecté invalide.");
  const u = await User.findOne({ where: { id, isActive: true, role: { [Op.in]: ASSIGNEE_ROLES } }, attributes: ["id", "email"] });
  if (!u) throw new HttpError(400, "ASSIGNEE_INVALID", "L'utilisateur affecté doit être un utilisateur CRM actif ayant accès aux notes de calcul.");
  return u;
}

// null / "" = aucune affectation ; refusé si l'affectation est obligatoire.
async function readAssignee(raw) {
  const id = raw === undefined || raw === null || raw === "" ? null : String(raw);
  if (!id) {
    if (wf.assigneeRequired()) throw new HttpError(400, "ASSIGNEE_REQUIRED", "Sélectionnez l'utilisateur affecté à la note.");
    return null;
  }
  return findAssignee(id);
}

function requireReason(v, code, message) {
  const s = cleanComment(v);
  if (!s || s.length < wf.MIN_REASON_LENGTH) throw new HttpError(400, code, message);
  return s;
}

// ── Lecture des paramètres ───────────────────────────────────────────────
function cleanComment(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s.length > MAX_COMMENT) throw new HttpError(400, "COMMENT_TOO_LONG", `Commentaire limité à ${MAX_COMMENT} caractères.`);
  return s || null;
}

function cleanTitle(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (s.length > MAX_TITLE) throw new HttpError(400, "TITLE_TOO_LONG", `Nom du document limité à ${MAX_TITLE} caractères.`);
  return s || null;
}

function cleanType(v) {
  if (v === undefined || v === null || v === "") return null;
  if (!DOCUMENT_TYPES.includes(v)) throw new HttpError(400, "INVALID_DOCUMENT_TYPE", "Type de document inconnu.");
  return v;
}

function parseArray(body, field, count) {
  if (body[field] === undefined) return [];
  let list;
  try {
    list = typeof body[field] === "string" ? JSON.parse(body[field]) : body[field];
  } catch (_) {
    list = null;
  }
  if (!Array.isArray(list)) throw new HttpError(400, "INVALID_DOCUMENT_FIELDS", `${field} doit être un tableau JSON.`);
  if (list.length > count) throw new HttpError(400, "INVALID_DOCUMENT_FIELDS", `Plus d'éléments dans ${field} que de fichiers.`);
  return list;
}

// Par fichier, dans l'ordre des fichiers : `commentaires`, `titres`, `types`
// (tableaux JSON). `commentaire` seul = observations de la note.
function parseFileMeta(body, count) {
  const comments = parseArray(body, "commentaires", count);
  const titles = parseArray(body, "titres", count);
  const types = parseArray(body, "types", count);
  return Array.from({ length: count }, (_, i) => ({
    commentaire: cleanComment(comments[i]),
    title: cleanTitle(titles[i]),
    documentType: cleanType(types[i]),
  }));
}

async function findRequester(requesterId) {
  if (!isUuid(requesterId)) throw new HttpError(400, "REQUESTER_REQUIRED", "Le demandeur est obligatoire.");
  const u = await User.findOne({ where: { id: requesterId, isActive: true, role: { [Op.in]: REQUESTER_ROLES } }, attributes: ["id"] });
  if (!u) throw new HttpError(400, "REQUESTER_INVALID", "Le demandeur doit être un utilisateur CRM actif.");
  return u;
}

// Écrit les fichiers (après contrôle du contenu) ; en cas d'échec, retire
// ceux déjà écrits.
async function storeAll(files) {
  const stored = [];
  try {
    for (const f of files) stored.push(await storeFile(f));
    return stored;
  } catch (e) {
    await removeStoredFiles(stored.map((s) => s.storedFileName));
    if (e instanceof UploadRejected) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
}

// origin : INITIAL (création) | ADDED (éditeur) | COMPLEMENTARY (affecté).
// Toujours des AJOUTS : un document existant n'est jamais remplacé.
async function insertDocuments({ note, user, stored, meta, transaction, origin = "INITIAL" }) {
  const docs = [];
  for (let i = 0; i < stored.length; i += 1) {
    const doc = await CalculationNoteDocument.create(
      { ...stored[i], ...meta[i], origin, noteId: note.id, projectId: note.projectId, uploadedBy: user.sub },
      { transaction }
    );
    await CalculationNoteHistory.create(
      {
        noteId: note.id,
        documentId: doc.id,
        action: "DOCUMENT_ADDED",
        userId: user.sub,
        details: { origin, originalName: doc.originalName, title: doc.title, documentType: doc.documentType, extension: doc.extension, sizeBytes: Number(doc.sizeBytes), commentaire: doc.commentaire },
      },
      { transaction }
    );
    docs.push(doc);
  }
  return docs;
}

// ── Cas d'usage ──────────────────────────────────────────────────────────
async function loadNoteForUser(user, id) {
  const noteId = Number(id);
  if (!Number.isInteger(noteId) || noteId <= 0) throw new HttpError(400, "INVALID_ID", "Identifiant de note invalide.");
  const note = await CalculationNote.findOne({ where: { [Op.and]: [{ id: noteId }, readScope(user)] } });
  if (!note) throw new HttpError(404, "NOT_FOUND", "Note de calcul introuvable.");
  return note;
}

async function getNote(user, id) {
  const base = await loadNoteForUser(user, id);
  const note = await CalculationNote.findByPk(base.id, {
    include: [
      { model: Project, as: "project", attributes: ["id", "nomProjet", "statut", "projectModele", "entreprise", "adresse", "isArchived", "ownerId"] },
      userInclude("requester"),
      userInclude("creator"),
      userInclude("validator"),
      userInclude("decider"),
      userInclude("canceller"),
      userInclude("assignee"),
      userInclude("assigner"),
      { model: CalculationNoteDocument, as: "documents", include: [userInclude("uploader")] },
      { model: CalculationNoteHistory, as: "history", include: [userInclude("user")] },
    ],
    order: [
      [{ model: CalculationNoteDocument, as: "documents" }, "createdAt", "ASC"],
      [{ model: CalculationNoteHistory, as: "history" }, "createdAt", "DESC"],
    ],
  });
  const canEdit = await canEditNote(user, note, note.project);
  return {
    id: note.id,
    reference: note.reference,
    year: note.year,
    sequenceNumber: note.sequenceNumber,
    project: projectDto(note.project),
    requester: userDto(note.requester),
    creator: userDto(note.creator),
    commentaire: note.commentaire,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    documents: note.documents.map(documentDto),
    history: note.history.map((h) => ({ id: h.id, action: h.action, documentId: h.documentId, user: userDto(h.user), details: h.details, createdAt: h.createdAt })),
    ...workflowDto(note, user),
    canEdit,
    canResubmit: note.status === wf.STATUSES.REJECTED && canEdit,
    // Affectation modifiable aux mêmes conditions que la note.
    canAssign: canEdit,
    // Dépôt de documents complémentaires : l'utilisateur affecté, tant que la
    // note n'est ni validée ni annulée.
    canAddComplementary: !isBackoffice(user) && note.assignedToUserId === user.sub && wf.EDITABLE_STATUSES.includes(note.status),
    canManageNotifications: await canManageNotifications(user, note, canEdit),
  };
}

async function createNote(user, body, files = []) {
  if (!isUuid(body.projectId)) throw new HttpError(400, "PROJECT_REQUIRED", "Le projet est obligatoire.");
  const project = await Project.findByPk(body.projectId, { attributes: ["id", "ownerId", "isArchived"] });
  if (!project) throw new HttpError(400, "PROJECT_INVALID", "Projet introuvable.");
  if (!(await canWriteProject(user, project))) {
    throw new HttpError(403, "PERMISSION_DENIED", "Vous n'avez pas les droits de modification sur ce projet.");
  }
  await findRequester(body.requesterId);
  const commentaire = cleanComment(body.commentaire);
  const meta = parseFileMeta(body, files.length);
  const assignee = await readAssignee(body.assignedToUserId);
  const validator = await resolveValidator(); // avant tout fichier écrit

  const stored = await storeAll(files);
  try {
    const id = await sequelize.transaction(async (transaction) => {
      const ref = await nextReference(transaction);
      const note = await CalculationNote.create(
        {
          ...ref,
          projectId: project.id,
          requesterId: body.requesterId,
          createdBy: user.sub,
          commentaire,
          status: wf.STATUSES.PENDING,
          validatorId: validator.id,
          submissionVersion: 1,
          submittedAt: new Date(),
          ...(assignee ? { assignedToUserId: assignee.id, assignedAt: new Date(), assignedByUserId: user.sub, assignmentVersion: 1 } : {}),
        },
        { transaction }
      );
      await CalculationNoteHistory.create(
        {
          noteId: note.id,
          action: "NOTE_CREATED",
          userId: user.sub,
          details: { reference: note.reference, projectId: project.id, requesterId: body.requesterId, documents: stored.length },
        },
        { transaction }
      );
      await insertDocuments({ note, user, stored, meta, transaction });
      await CalculationNoteHistory.create(
        { noteId: note.id, action: "NOTE_SUBMITTED", userId: user.sub, details: { validatorId: validator.id, validatorEmail: validator.email, submissionVersion: 1 } },
        { transaction }
      );
      if (assignee) {
        await CalculationNoteHistory.create(
          { noteId: note.id, action: "NOTE_ASSIGNED", userId: user.sub, details: { from: null, fromEmail: null, to: assignee.id, toEmail: assignee.email, assignmentVersion: 1 } },
          { transaction }
        );
      }
      return note.id;
    });
    notify.notifySubmitted(id);
    if (assignee) notify.notifyAssignment(id);
    return getNote(user, id);
  } catch (e) {
    await removeStoredFiles(stored.map((s) => s.storedFileName));
    throw e;
  }
}

function assertEditableStatus(note) {
  if (wf.EDITABLE_STATUSES.includes(note.status)) return;
  throw new HttpError(
    409,
    "NOTE_LOCKED",
    note.status === wf.STATUSES.VALIDATED
      ? "Cette note est validée : elle ne peut plus être modifiée."
      : "Cette note est annulée : elle ne peut plus être modifiée.",
    { status: note.status }
  );
}

async function requireEditable(user, id) {
  const note = await loadNoteForUser(user, id);
  assertEditableStatus(note);
  const project = await Project.findByPk(note.projectId, { attributes: ["id", "ownerId", "isArchived"] });
  if (!(await canEditNote(user, note, project))) {
    throw new HttpError(403, "PERMISSION_DENIED", "Vous n'avez pas les droits de modification sur cette note.");
  }
  return note;
}

// Informations modifiables : demandeur et observations générales (le projet
// et la référence restent ceux de la création).
async function updateNote(user, id, body) {
  const note = await requireEditable(user, id);
  const changes = {};
  if (body.requesterId !== undefined && body.requesterId !== note.requesterId) {
    await findRequester(body.requesterId);
    changes.requesterId = { from: note.requesterId, to: body.requesterId };
  }
  if (body.commentaire !== undefined) {
    const c = cleanComment(body.commentaire);
    if (c !== note.commentaire) changes.commentaire = { from: note.commentaire, to: c };
  }
  if (Object.keys(changes).length) {
    await sequelize.transaction(async (transaction) => {
      for (const [k, v] of Object.entries(changes)) note[k] = v.to;
      await note.save({ transaction });
      await CalculationNoteHistory.create({ noteId: note.id, action: "NOTE_UPDATED", userId: user.sub, details: { changes } }, { transaction });
    });
  }
  return getNote(user, note.id);
}

async function addDocuments(user, id, body, files = []) {
  if (!files.length) throw new HttpError(400, "FILE_REQUIRED", "Ajoutez au moins un document (PDF, DOC, DOCX, XLS, XLSX).");
  const note = await requireEditable(user, id);
  const meta = parseFileMeta(body, files.length);
  const stored = await storeAll(files);
  try {
    await sequelize.transaction(async (transaction) => {
      await insertDocuments({ note, user, stored, meta, transaction, origin: "ADDED" });
      note.changed("updatedAt", true);
      await note.save({ transaction });
    });
  } catch (e) {
    await removeStoredFiles(stored.map((s) => s.storedFileName));
    throw e;
  }
  return getNote(user, note.id);
}

async function updateDocumentComment(user, id, docId, body) {
  const note = await requireEditable(user, id);
  if (!isUuid(docId)) throw new HttpError(400, "INVALID_ID", "Identifiant de document invalide.");
  const doc = await CalculationNoteDocument.findOne({ where: { id: docId, noteId: note.id } });
  if (!doc) throw new HttpError(404, "NOT_FOUND", "Document introuvable.");
  const next = {};
  if (body.commentaire !== undefined) next.commentaire = cleanComment(body.commentaire);
  if (body.title !== undefined) next.title = cleanTitle(body.title);
  if (body.documentType !== undefined) next.documentType = cleanType(body.documentType);
  const changes = {};
  for (const [k, v] of Object.entries(next)) if (v !== doc[k]) changes[k] = { from: doc[k], to: v };
  if (Object.keys(changes).length) {
    await sequelize.transaction(async (transaction) => {
      for (const [k, v] of Object.entries(changes)) doc[k] = v.to;
      await doc.save({ transaction });
      // Historique : from/to = commentaire (compatibilité), changes = détail.
      const details = { originalName: doc.originalName, changes };
      if (changes.commentaire) Object.assign(details, changes.commentaire);
      await CalculationNoteHistory.create(
        { noteId: note.id, documentId: doc.id, action: changes.commentaire && Object.keys(changes).length === 1 ? "DOCUMENT_COMMENT_UPDATED" : "DOCUMENT_UPDATED", userId: user.sub, details },
        { transaction }
      );
    });
  }
  return getNote(user, note.id);
}

// Validation / refus : uniquement par le validateur enregistré sur la note,
// une seule fois. La mise à jour est conditionnelle (statut EN_ATTENTE et
// soumission attendue) : deux décisions concurrentes ne peuvent pas aboutir
// toutes les deux — la seconde reçoit 409.
async function decide(user, id, decision, body = {}) {
  const note = await loadNoteForUser(user, id);
  const byBackoffice = isBackoffice(user);
  if (!byBackoffice && (!note.validatorId || note.validatorId !== user.sub)) {
    throw new HttpError(403, "NOT_VALIDATOR", "Seul le validateur désigné ou le back-office peut valider ou refuser cette note.");
  }
  const validated = decision === "validate";
  const comment = validated
    ? cleanComment(body.commentaire)
    : requireReason(body.commentaire, "REJECTION_COMMENT_REQUIRED", "Le motif du refus est obligatoire.");
  if (body.submissionVersion !== undefined && Number(body.submissionVersion) !== note.submissionVersion) {
    throw new HttpError(409, "STALE_SUBMISSION", "La note a été soumise de nouveau entre-temps : rechargez-la avant de décider.", { status: note.status });
  }
  const to = validated ? wf.STATUSES.VALIDATED : wf.STATUSES.REJECTED;
  const applied = await sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      `UPDATE calculation_notes
          SET status = :to, "decidedBy" = :me, "decidedAt" = NOW(), "decisionComment" = :comment, "updatedAt" = NOW()
        WHERE id = :id AND status = :pending AND ("validatorId" = :me OR :byBackoffice) AND "submissionVersion" = :version
      RETURNING id`,
      { replacements: { to, me: user.sub, byBackoffice, comment, id: note.id, pending: wf.STATUSES.PENDING, version: note.submissionVersion }, transaction }
    );
    if (!rows.length) return false;
    await CalculationNoteHistory.create(
      {
        noteId: note.id,
        action: validated ? "NOTE_VALIDATED" : "NOTE_REJECTED",
        userId: actorId(user),
        details: { commentaire: comment, submissionVersion: note.submissionVersion, decidedAs: byBackoffice ? "BACKOFFICE" : "VALIDATOR" },
      },
      { transaction }
    );
    return true;
  });
  if (!applied) {
    const current = await CalculationNote.findByPk(note.id, { attributes: ["status"] });
    throw new HttpError(409, "ALREADY_DECIDED", `Cette note n'est plus en attente de validation (statut : ${wf.STATUS_LABELS[current.status] || current.status}).`, { status: current.status });
  }
  notify.notifyDecision(note.id);
  return getNote(user, note.id);
}

// Annulation par le CRÉATEUR uniquement, motif obligatoire ; impossible pour
// une note validée (verrouillée) ou déjà annulée.
async function cancelNote(user, id, body = {}) {
  const note = await loadNoteForUser(user, id);
  if (note.createdBy !== user.sub) throw new HttpError(403, "NOT_CREATOR", "Seul le créateur de la note peut l'annuler.");
  const reason = requireReason(body.motif ?? body.reason, "CANCELLATION_REASON_REQUIRED", "Le motif de l'annulation est obligatoire.");
  const applied = await sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      `UPDATE calculation_notes
          SET status = :to, "cancelledBy" = :me, "cancelledAt" = NOW(), "cancellationReason" = :reason, "updatedAt" = NOW()
        WHERE id = :id AND status IN (:allowed) AND "createdBy" = :me
      RETURNING id`,
      { replacements: { to: wf.STATUSES.CANCELLED, me: user.sub, reason, id: note.id, allowed: wf.CANCELLABLE_STATUSES }, transaction }
    );
    if (!rows.length) return false;
    await CalculationNoteHistory.create({ noteId: note.id, action: "NOTE_CANCELLED", userId: user.sub, details: { motif: reason, previousStatus: note.status } }, { transaction });
    return true;
  });
  if (!applied) {
    const current = await CalculationNote.findByPk(note.id, { attributes: ["status"] });
    throw new HttpError(
      409,
      current.status === wf.STATUSES.VALIDATED ? "NOTE_LOCKED" : "ALREADY_CANCELLED",
      current.status === wf.STATUSES.VALIDATED ? "Cette note est validée : elle ne peut plus être annulée." : "Cette note est déjà annulée.",
      { status: current.status }
    );
  }
  notify.notifyCancelled(note.id);
  return getNote(user, note.id);
}

// Note refusée, corrigée, soumise de nouveau : nouvelle soumission (n° + 1),
// de nouveau en attente du validateur. La décision précédente reste dans
// l'historique.
async function resubmitNote(user, id) {
  const note = await requireEditable(user, id);
  if (note.status !== wf.STATUSES.REJECTED) {
    throw new HttpError(409, "NOT_REJECTED", "Seule une note refusée peut être soumise de nouveau.", { status: note.status });
  }
  const validator = await resolveValidator();
  const applied = await sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      `UPDATE calculation_notes
          SET status = :pending, "validatorId" = :validatorId, "submissionVersion" = "submissionVersion" + 1, "submittedAt" = NOW(),
              "decidedBy" = NULL, "decidedAt" = NULL, "decisionComment" = NULL, "updatedAt" = NOW()
        WHERE id = :id AND status = :rejected
      RETURNING "submissionVersion"`,
      { replacements: { pending: wf.STATUSES.PENDING, rejected: wf.STATUSES.REJECTED, validatorId: validator.id, id: note.id }, transaction }
    );
    if (!rows.length) return false;
    await CalculationNoteHistory.create(
      { noteId: note.id, action: "NOTE_RESUBMITTED", userId: user.sub, details: { validatorId: validator.id, validatorEmail: validator.email, submissionVersion: rows[0].submissionVersion } },
      { transaction }
    );
    return true;
  });
  if (!applied) throw new HttpError(409, "NOT_REJECTED", "Seule une note refusée peut être soumise de nouveau.");
  notify.notifySubmitted(note.id, { resubmitted: true });
  return getNote(user, note.id);
}

// Documents complémentaires — réponse de l'utilisateur AFFECTÉ uniquement
// (vérifié ici, pas seulement dans l'interface). Les documents initiaux ne
// sont jamais remplacés ; le statut ne change pas (aucune validation
// automatique) ; créateur, demandeur et validateur sont informés.
async function addComplementaryDocuments(user, id, body, files = []) {
  const note = await loadNoteForUser(user, id);
  if (note.assignedToUserId !== user.sub) {
    throw new HttpError(403, "NOT_ASSIGNEE", "Seul l'utilisateur affecté peut déposer des documents complémentaires.");
  }
  assertEditableStatus(note);
  if (!files.length) throw new HttpError(400, "FILE_REQUIRED", "Ajoutez au moins un document (PDF, DOC, DOCX, XLS, XLSX).");
  const meta = parseFileMeta(body, files.length);
  const stored = await storeAll(files);
  let version;
  let documentIds;
  try {
    await sequelize.transaction(async (transaction) => {
      // Conditionnel : toujours affecté à cet utilisateur et modifiable.
      const [rows] = await sequelize.query(
        `UPDATE calculation_notes SET "complementaryVersion" = "complementaryVersion" + 1, "updatedAt" = NOW()
          WHERE id = :id AND "assignedToUserId" = :me AND status IN (:editable)
        RETURNING "complementaryVersion"`,
        { replacements: { id: note.id, me: user.sub, editable: wf.EDITABLE_STATUSES }, transaction }
      );
      if (!rows.length) throw new HttpError(409, "NOTE_LOCKED", "Cette note n'accepte plus de documents complémentaires.");
      version = rows[0].complementaryVersion;
      const docs = await insertDocuments({ note, user, stored, meta, transaction, origin: "COMPLEMENTARY" });
      documentIds = docs.map((d) => d.id);
      await CalculationNoteHistory.create(
        {
          noteId: note.id,
          action: "COMPLEMENTARY_DOCUMENTS_ADDED",
          userId: user.sub,
          details: {
            complementaryVersion: version,
            count: docs.length,
            documents: docs.map((d) => ({ id: d.id, originalName: d.originalName, documentType: d.documentType, commentaire: d.commentaire })),
          },
        },
        { transaction }
      );
    });
  } catch (e) {
    await removeStoredFiles(stored.map((s) => s.storedFileName));
    throw e;
  }
  notify.notifyComplementaryDocuments(note.id, { version, uploaderId: user.sub, documentIds });
  return getNote(user, note.id);
}

// Affectation : modification ou retrait, aux mêmes conditions que la note
// (créateur, propriétaire / éditeur du projet, admin ; note ni validée ni
// annulée). L'historique de validation n'est jamais touché.
async function setAssignment(user, id, body = {}) {
  const note = await requireEditable(user, id);
  const assignee = await readAssignee(body.assignedToUserId);
  const previousId = note.assignedToUserId || null;
  const nextId = assignee?.id || null;
  if (previousId === nextId) return getNote(user, note.id);
  const previous = previousId ? await User.findByPk(previousId, { attributes: ["email"] }) : null;
  await sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      `UPDATE calculation_notes
          SET "assignedToUserId" = :nextId, "assignedAt" = NOW(), "assignedByUserId" = :me,
              "assignmentVersion" = "assignmentVersion" + 1, "updatedAt" = NOW()
        WHERE id = :id AND status IN (:editable)
      RETURNING "assignmentVersion"`,
      { replacements: { nextId, me: user.sub, id: note.id, editable: wf.EDITABLE_STATUSES }, transaction }
    );
    if (!rows.length) throw new HttpError(409, "NOTE_LOCKED", "Cette note n'est plus modifiable.");
    await CalculationNoteHistory.create(
      {
        noteId: note.id,
        action: nextId ? (previousId ? "ASSIGNMENT_CHANGED" : "NOTE_ASSIGNED") : "ASSIGNMENT_REMOVED",
        userId: user.sub,
        details: { from: previousId, fromEmail: previous?.email || null, to: nextId, toEmail: assignee?.email || null, assignmentVersion: rows[0].assignmentVersion },
      },
      { transaction }
    );
  });
  notify.notifyAssignment(note.id, { previousUserId: previousId });
  return getNote(user, note.id);
}

const ASSIGNMENT_ACTIONS = ["NOTE_ASSIGNED", "ASSIGNMENT_CHANGED", "ASSIGNMENT_REMOVED"];

async function getAssignments(user, id) {
  const note = await loadNoteForUser(user, id);
  const rows = await CalculationNoteHistory.findAll({
    where: { noteId: note.id, action: ASSIGNMENT_ACTIONS },
    include: [userInclude("user")],
    order: [["createdAt", "DESC"]],
  });
  const ids = [...new Set(rows.flatMap((r) => [r.details?.from, r.details?.to]).filter(Boolean))];
  const users = new Map(
    (await User.findAll({ where: { id: ids }, attributes: ["id", "email", "isActive", "role"], include: [{ model: UserProfile, as: "profile", attributes: ["name", "prenom", "nom"], required: false }] })).map((u) => [u.id, userDto(u)])
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    from: r.details?.from ? users.get(r.details.from) || { id: r.details.from, email: r.details.fromEmail, name: r.details.fromEmail } : null,
    to: r.details?.to ? users.get(r.details.to) || { id: r.details.to, email: r.details.toEmail, name: r.details.toEmail } : null,
    by: userDto(r.user),
    createdAt: r.createdAt,
  }));
}

// « Affecter à » : tous les utilisateurs CRM actifs ayant accès au module,
// lus en base (recherche nom / prénom / email).
async function assignableUsers(query = {}) {
  const where = { isActive: true, role: { [Op.in]: ASSIGNEE_ROLES } };
  const users = await User.findAll({
    where,
    attributes: ["id", "email", "isActive", "role"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "prenom", "nom"], required: false }],
    order: [["email", "ASC"]],
  });
  const q = String(query.q || "").trim().toLowerCase();
  return users
    .map((u) => ({ ...userDto(u, { withRole: true }), search: [u.email, u.profile?.name, u.profile?.prenom, u.profile?.nom].filter(Boolean).join(" ").toLowerCase() }))
    .filter((u) => !q || u.search.includes(q))
    .map(({ search, ...u }) => u)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

// Suivi des emails d'une note : créateur, validateur, éditeurs, admins.
async function canManageNotifications(user, note, canEdit) {
  if (isBackoffice(user)) return false;
  if (isAdmin(user) || note.createdBy === user.sub || note.validatorId === user.sub) return true;
  return canEdit === undefined ? canEditNote(user, note, await Project.findByPk(note.projectId, { attributes: ["id", "ownerId", "isArchived"] })) : canEdit;
}

async function emailJobs(noteId) {
  const [rows] = await sequelize.query(
    `SELECT id, "to", subject, status::text AS status, attempts, "lastErrorMessage", "lastAttemptAt", "nextAttemptAt", "sentAt", "createdAt", meta->>'type' AS type
       FROM email_queue WHERE context = :ctx AND (meta->>'calculationNoteId')::int = :noteId ORDER BY "createdAt" ASC`,
    { replacements: { ctx: notify.CONTEXT, noteId } }
  );
  return rows;
}

async function requireNotificationAccess(user, id) {
  const note = await loadNoteForUser(user, id);
  if (!(await canManageNotifications(user, note))) throw new HttpError(403, "PERMISSION_DENIED", "Suivi des envois réservé au créateur, au validateur et aux éditeurs de la note.");
  return note;
}

async function getEmailNotifications(user, id) {
  const note = await requireNotificationAccess(user, id);
  return emailJobs(note.id);
}

// Relance des emails en échec définitif (même contenu, même destinataire,
// jamais de doublon : la ligne existante est retentée).
async function resendFailedEmails(user, id) {
  const note = await requireNotificationAccess(user, id);
  const failed = (await emailJobs(note.id)).filter((j) => j.status === "FAILED");
  const results = [];
  for (const j of failed) results.push(await retryFailedJob(j.id));
  return { retried: results.length, results, emails: await emailJobs(note.id) };
}

async function isValidatorUser(user) {
  if (isBackoffice(user)) return true;
  const email = wf.validatorEmail();
  if (String(user.email || "").toLowerCase() === email) return true;
  return (await CalculationNote.count({ where: { validatorId: user.sub } })) > 0;
}

// « Validation des notes de calcul » : notes soumises à l'utilisateur
// connecté. Refusé (403) à tout autre compte.
async function validationQueue(user, query = {}) {
  if (!(await isValidatorUser(user))) throw new HttpError(403, "NOT_VALIDATOR", "Rubrique réservée au validateur des notes de calcul.");
  return listNotes(user, { ...query, assignedToMe: "1" });
}

async function getPermissions(user) {
  const isValidator = await isValidatorUser(user);
  const pendingToValidate = isValidator
    ? await CalculationNote.count({ where: { status: wf.STATUSES.PENDING, ...(isBackoffice(user) ? {} : { validatorId: user.sub }) } })
    : 0;
  return { isValidator, pendingToValidate };
}

async function getDocumentFile(user, id, docId) {
  const note = await loadNoteForUser(user, id);
  if (!isUuid(docId)) throw new HttpError(400, "INVALID_ID", "Identifiant de document invalide.");
  const doc = await CalculationNoteDocument.findOne({ where: { id: docId, noteId: note.id } });
  if (!doc) throw new HttpError(404, "NOT_FOUND", "Document introuvable.");
  const fullPath = resolveStoredPath(doc.storedFileName);
  if (!fullPath) throw new HttpError(404, "FILE_MISSING", "Fichier introuvable sur le serveur.");
  return { doc, fullPath };
}

async function getHistory(user, id) {
  const note = await loadNoteForUser(user, id);
  const rows = await CalculationNoteHistory.findAll({ where: { noteId: note.id }, include: [userInclude("user")], order: [["createdAt", "DESC"]] });
  return rows.map((h) => ({ id: h.id, action: h.action, documentId: h.documentId, user: userDto(h.user), details: h.details, createdAt: h.createdAt }));
}

function dayStart(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? new Date(`${d}T00:00:00${TZ_OFFSET}`) : null;
}

async function listNotes(user, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const scope = readScope(user);
  const filters = [scope];

  const esc = (s) => String(s).trim().replace(/[%_\\]/g, (c) => `\\${c}`);
  if (query.reference && String(query.reference).trim()) filters.push({ reference: { [Op.iLike]: `%${esc(query.reference)}%` } });
  if (isUuid(query.projectId)) filters.push({ projectId: query.projectId });
  if (query.project && String(query.project).trim()) filters.push({ "$project.nomProjet$": { [Op.iLike]: `%${esc(query.project)}%` } });
  if (isUuid(query.requesterId)) filters.push({ requesterId: query.requesterId });
  if (query.assignedToMe === "1" && !isBackoffice(user)) filters.push({ validatorId: user.sub });
  if (isUuid(query.assignedToUserId)) filters.push({ assignedToUserId: query.assignedToUserId });
  const statuses = String(query.status || "").split(",").map((x) => x.trim()).filter((x) => wf.STATUS_LABELS[x]);
  if (statuses.length) filters.push({ status: { [Op.in]: statuses } });
  const from = dayStart(query.from);
  const to = dayStart(query.to);
  if (from) filters.push({ createdAt: { [Op.gte]: from } });
  if (to) filters.push({ createdAt: { [Op.lt]: new Date(to.getTime() + 86400000) } });

  const dir = String(query.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const order = query.sortBy === "reference" ? [["year", dir], ["sequenceNumber", dir]] : [["createdAt", dir], ["id", dir]];

  const where = { [Op.and]: filters };
  const { rows, count } = await CalculationNote.findAndCountAll({
    where,
    include: [
      { model: Project, as: "project", attributes: ["id", "nomProjet", "statut", "isArchived"] },
      userInclude("requester"),
      userInclude("creator"),
      userInclude("validator"),
      userInclude("decider"),
      userInclude("canceller"),
      userInclude("assignee"),
      userInclude("assigner"),
    ],
    attributes: {
      include: [
        [sequelize.literal(`(SELECT COUNT(*)::int FROM calculation_note_documents d WHERE d."noteId" = "CalculationNote"."id")`), "documentsCount"],
        [
          sequelize.literal(`(SELECT d.commentaire FROM calculation_note_documents d WHERE d."noteId" = "CalculationNote"."id" AND d.commentaire IS NOT NULL ORDER BY d."createdAt" ASC LIMIT 1)`),
          "firstDocumentComment",
        ],
        [sequelize.literal(canEditSql(user)), "canEdit"],
      ],
    },
    order,
    limit,
    offset: (page - 1) * limit,
    distinct: true,
    subQuery: false,
  });

  // Indicateurs (portée de l'utilisateur, sans les filtres de recherche).
  const monthStart = dayStart(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis", year: "numeric", month: "2-digit" }).format(new Date()) + "-01");
  const statusScope = query.assignedToMe === "1" && !isBackoffice(user) ? { [Op.and]: [scope, { validatorId: user.sub }] } : scope;
  const [total, thisMonth, mine, documents, byStatusRows] = await Promise.all([
    CalculationNote.count({ where: scope }),
    CalculationNote.count({ where: { [Op.and]: [scope, { createdAt: { [Op.gte]: monthStart } }] } }),
    CalculationNote.count({ where: { createdBy: actorId(user) } }), // « Mes notes » : identité réelle
    CalculationNoteDocument.count({ include: [{ model: CalculationNote, as: "note", where: scope, attributes: [] }] }),
    CalculationNote.count({ where: statusScope, group: ["status"] }),
  ]);
  // Notes par créateur, sur le même périmètre que la liste.
  const byCreatorRows = await CalculationNote.findAll({
    where: scope,
    attributes: ["createdBy", [sequelize.fn("COUNT", sequelize.col("CalculationNote.id")), "count"]],
    include: [userInclude("creator")],
    group: ["CalculationNote.createdBy", "creator.id", "creator->profile.id"],
  });
  const byCreator = byCreatorRows
    .map((r) => ({ user: userDto(r.creator), count: Number(r.get("count")) }))
    .sort((a, b) => b.count - a.count || a.user.name.localeCompare(b.user.name, "fr"));
  const byStatus = Object.fromEntries(Object.keys(wf.STATUS_LABELS).map((k) => [k, 0]));
  for (const r of byStatusRows) byStatus[r.status] = Number(r.count);

  return {
    data: rows.map((n) => {
      const j = n.get({ plain: true });
      return {
        id: n.id,
        reference: n.reference,
        project: projectDto(n.project),
        requester: userDto(n.requester),
        creator: userDto(n.creator),
        createdAt: n.createdAt,
        documentsCount: Number(j.documentsCount || 0),
        commentaire: n.commentaire || j.firstDocumentComment || null,
        observations: n.commentaire,
        canEdit: j.canEdit === true,
        ...workflowDto(n, user),
      };
    }),
    pagination: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
    summary: { total, thisMonth, documents, mine, ...byStatus, byCreator },
  };
}

// Listes déroulantes du formulaire : projets où l'utilisateur peut créer une
// note, et demandeurs (utilisateurs CRM actifs).
async function getOptions(user, query = {}) {
  const where = {};
  if (!isAdmin(user)) {
    const me = sequelize.escape(user.sub);
    where.isArchived = { [Op.not]: true };
    where.id = {
      [Op.in]: sequelize.literal(`(SELECT p.id FROM projects p WHERE p."ownerId" = ${me}
        UNION SELECT up."projectId" FROM user_projects up WHERE up."userId" = ${me} AND up.permission IN ('owner','editor'))`),
    };
  }
  if (query.q && String(query.q).trim()) where.nomProjet = { [Op.iLike]: `%${String(query.q).trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` };
  const [projects, users] = await Promise.all([
    Project.findAll({ where, attributes: ["id", "nomProjet", "statut", "entreprise", "isArchived"], order: [["nomProjet", "ASC"]], limit: 500 }),
    User.findAll({
      where: { isActive: true, role: { [Op.in]: REQUESTER_ROLES } },
      attributes: ["id", "email", "isActive"],
      include: [{ model: UserProfile, as: "profile", attributes: ["name", "prenom", "nom"], required: false }],
      order: [["email", "ASC"]],
    }),
  ]);
  return {
    projects: projects.map((p) => ({ id: p.id, nomProjet: p.nomProjet, statut: p.statut, entreprise: p.entreprise, isArchived: !!p.isArchived })),
    requesters: users.map((u) => userDto(u)).sort((a, b) => a.name.localeCompare(b.name, "fr")),
    assignees: await assignableUsers(),
    assigneeRequired: wf.assigneeRequired(),
    currentUserId: user.sub,
  };
}

module.exports = {
  DOCUMENT_TYPES,
  ADMIN_ROLES,
  MODULE_ROLES,
  REQUESTER_ROLES,
  HttpError,
  tunisYear,
  formatReference,
  nextReference,
  listNotes,
  getNote,
  createNote,
  updateNote,
  addDocuments,
  updateDocumentComment,
  decide,
  cancelNote,
  resubmitNote,
  validationQueue,
  getPermissions,
  setAssignment,
  getAssignments,
  addComplementaryDocuments,
  assignableUsers,
  getEmailNotifications,
  resendFailedEmails,
  getDocumentFile,
  getHistory,
  getOptions,
};
