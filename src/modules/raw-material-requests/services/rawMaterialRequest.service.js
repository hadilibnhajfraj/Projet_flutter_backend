"use strict";

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { Op, UniqueConstraintError } = require("sequelize");

const { sequelize } = require("../../../db");
const RawMaterialRequest = require("../../../models/RawMaterialRequest");
const RawMaterialRequestStatusHistory = require("../../../models/RawMaterialRequestStatusHistory");
const cfg = require("../../../config/rawMaterialRequest");
const notify = require("./rawMaterialRequestNotify.service");

dayjs.extend(utc);
dayjs.extend(timezone);

const { STATUSES, TRANSITIONS, INACTIVE_STATUSES, AWAITING_DECISION_STATUSES, EVENING_VISIBLE_STATUSES, TZ } = cfg;

// Libellés affichés (export Excel) — mêmes termes que l'interface.
const STATUS_LABELS = Object.freeze({
  DRAFT: "Brouillon",
  PENDING_VALIDATION: "En attente de validation",
  SUBMITTED: "Soumise",
  VALIDATED: "Validée",
  REJECTED: "Rejetée",
  IN_PROGRESS: "En cours de traitement",
  PROCESSED: "Traitée",
  EVENING_ACCEPTED: "Acceptée par le shift soir",
  EVENING_REFUSED: "Refusée par le shift soir",
});

class RawMaterialRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  toJSON() {
    return { success: false, code: this.code, message: this.message };
  }
}

const notFound = () => new RawMaterialRequestError(404, "NOT_FOUND", "Demande de matières premières introuvable.");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lower = (v) => String(v || "").trim().toLowerCase();

/** Demande du jour (vendredi) de cet utilisateur à ce poste, quel que soit son statut. */
async function findDayRequest({ userId, poste, date }) {
  return RawMaterialRequest.findOne({ where: { userId, poste, requestDate: date } });
}

const isActive = (row) => !!row && !INACTIVE_STATUSES.includes(row.status);

/**
 * Faut-il (encore) faire la demande du jour ? Uniquement le vendredi (heure
 * du serveur) pour les comptes / postes concernés, et seulement si aucune
 * demande active n'existe déjà pour ce vendredi. Une demande rejetée est
 * renvoyée (`rejectedRequest`) pour être corrigée et soumise à nouveau.
 */
async function requirementFor(user, { module, poste }) {
  poste = poste || cfg.sessionPosteFor(user?.email);
  const now = cfg.clock();
  const day = cfg.dayContext(now);
  const base = {
    required: false,
    poste,
    requestDate: day.date,
    isRequestDay: day.isRequestDay,
    deadlineAt: day.isRequestDay ? day.deadlineAt : null,
    deadlinePassed: day.isRequestDay && day.deadlinePassed,
    pendingRequestId: null,
    rejectedRequest: null,
    materials: cfg.MATERIALS,
    unit: cfg.UNIT,
  };
  if (!cfg.isRequiredFor({ email: user?.email, poste, module: module || null, now })) return base;

  const existing = await findDayRequest({ userId: user.sub, poste, date: day.date });
  if (isActive(existing)) return { ...base, pendingRequestId: existing.id };
  return {
    ...base,
    required: true,
    rejectedRequest:
      existing?.status === STATUSES.REJECTED
        ? { id: existing.id, requestNumber: existing.requestNumber, items: existing.items, comment: existing.rejectionComment || null }
        : null,
  };
}

/**
 * Popup à la connexion : le poste n'est pas encore choisi dans l'interface,
 * il est déduit des horaires de production du compte (config).
 */
async function sessionRequirement(user) {
  const poste = cfg.sessionPosteFor(user?.email);
  if (!poste) {
    return { required: false, poste: null, pendingRequestId: null, rejectedRequest: null, materials: cfg.MATERIALS, unit: cfg.UNIT };
  }
  return requirementFor(user, { module: null, poste });
}

function toHistoryResponse(h) {
  const j = typeof h.toJSON === "function" ? h.toJSON() : h;
  return {
    id: j.id,
    fromStatus: j.fromStatus,
    toStatus: j.toStatus,
    changedBy: j.changedBy,
    changedByEmail: j.changedByEmail,
    comment: j.comment,
    createdAt: j.createdAt,
  };
}

// Indicateurs d'échéance (calculés à la lecture, jamais stockés comme statut).
function deadlineFlags(j, now = cfg.clock()) {
  if (j.status !== STATUSES.PENDING_VALIDATION || !j.deadlineAt) return { overdue: false, dueSoon: false };
  const left = new Date(j.deadlineAt).getTime() - now.getTime();
  return { overdue: left <= 0, dueSoon: left > 0 && left <= cfg.dueSoonMinutes * 60 * 1000 };
}

function toResponse(r, { history, user } = {}) {
  const j = typeof r.toJSON === "function" ? r.toJSON() : r;
  return {
    id: j.id,
    requestNumber: j.requestNumber,
    userId: j.userId,
    userEmail: j.userEmail,
    module: j.module,
    machine: j.machine,
    poste: j.poste,
    requestDate: j.requestDate,
    productionDate: j.productionDate,
    items: j.items,
    status: j.status,
    deadlineAt: j.deadlineAt || null,
    ...deadlineFlags(j),
    validatedAt: j.validatedAt,
    validatedByEmail: j.validatedByEmail,
    rejectedAt: j.rejectedAt || null,
    rejectedByEmail: j.rejectedByEmail || null,
    rejectionComment: j.rejectionComment || null,
    actualItems: j.actualItems || null,
    eveningHandledAt: j.eveningHandledAt || null,
    eveningHandledByEmail: j.eveningHandledByEmail || null,
    eveningRefusalComment: j.eveningRefusalComment || null,
    consumedAt: j.consumedAt,
    ficheType: j.ficheType,
    ficheId: j.ficheId,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    ...(history ? { history: history.map(toHistoryResponse) } : {}),
    // Le demandeur peut corriger et soumettre à nouveau sa demande rejetée.
    ...(user ? { canResubmit: j.status === STATUSES.REJECTED && j.userId === user.sub } : {}),
    // Shift soir : demande validée à accepter / refuser.
    ...(user ? { canEveningHandle: j.status === STATUSES.VALIDATED && cfg.isEveningHandler(user) && j.userId !== user.sub } : {}),
  };
}

// Les lignes sont reconstruites côté serveur à partir de la liste fixe des
// matières (libellé et unité jamais repris du client).
// Ordre canonique du modèle (ISO → FIBRE), quel que soit l'ordre reçu.
function buildItems(items) {
  return cfg.MATERIALS.flatMap(({ code, label }) => {
    const src = items.find((i) => i.material === code);
    if (!src) return [];
    return {
      material: code,
      label,
      reference: src.reference || null,
      lot: src.lot || null,
      quantiteDisponible: src.quantiteDisponible,
      besoinProduction: src.besoinProduction,
      quantiteDemandee: src.quantiteDemandee,
      unite: cfg.UNIT,
    };
  });
}

// Numéro unique DMP-AAAA-000001 : séquence PostgreSQL (jamais de doublon,
// même pour deux créations simultanées).
async function nextRequestNumber(transaction) {
  const [rows] = await sequelize.query(`SELECT nextval('raw_material_request_number_seq') AS n`, { transaction });
  const n = Number(rows?.[0]?.n);
  return `DMP-${dayjs(cfg.clock()).tz(TZ).format("YYYY")}-${String(n).padStart(6, "0")}`;
}

const duplicateError = (existing) =>
  new RawMaterialRequestError(
    409,
    existing?.status === STATUSES.REJECTED ? "REQUEST_REJECTED_RESUBMIT" : "DUPLICATE_REQUEST",
    existing?.status === STATUSES.REJECTED
      ? "La demande de ce vendredi a été rejetée : corrigez-la et soumettez-la à nouveau."
      : "Une demande de matières premières a déjà été soumise pour ce vendredi."
  );

// Échéance déjà dépassée à la soumission (vendredi après 14 h) : alerte immédiate.
async function flagLateIfNeeded(row) {
  if (row.status !== STATUSES.PENDING_VALIDATION || !row.deadlineAt) return;
  if (cfg.clock().getTime() < new Date(row.deadlineAt).getTime()) return;
  const [n] = await RawMaterialRequest.update({ lateNotifiedAt: cfg.clock() }, { where: { id: row.id, lateNotifiedAt: null } });
  if (n) await notify.notifyLate(row);
}

/**
 * Enregistre la demande du vendredi, EN ATTENTE DE VALIDATION par le
 * responsable logistique achats (aucune validation automatique), avec son
 * entrée d'historique. Une seule demande par vendredi, utilisateur et poste ;
 * idempotent sur (utilisateur, clientRequestId) : un double clic renvoie la
 * demande déjà enregistrée (created=false).
 */
async function createRequest(user, body) {
  const now = cfg.clock();
  if (!cfg.isRequiredFor({ email: user.email, poste: body.poste, module: body.module, now })) {
    throw new RawMaterialRequestError(
      403,
      "RAW_MATERIAL_REQUEST_NOT_APPLICABLE",
      "La demande de matières premières se fait uniquement le vendredi (poste Matin) pour ce compte."
    );
  }

  const where = { userId: user.sub, clientRequestId: body.clientRequestId };
  const existing = await RawMaterialRequest.findOne({ where });
  if (existing) return { request: toResponse(existing), created: false };

  const day = cfg.dayContext(now);
  const sameDay = await findDayRequest({ userId: user.sub, poste: body.poste, date: day.date });
  if (sameDay) throw duplicateError(sameDay);

  let created;
  try {
    created = await sequelize.transaction(async (transaction) => {
      const row = await RawMaterialRequest.create(
        {
          requestNumber: await nextRequestNumber(transaction),
          userId: user.sub,
          userEmail: lower(user.email),
          module: body.module || null,
          machine: body.machine == null || body.machine === "" ? null : String(body.machine),
          poste: body.poste,
          requestDate: day.date,
          productionDate: day.date,
          items: buildItems(body.items),
          status: STATUSES.PENDING_VALIDATION,
          deadlineAt: day.deadlineAt,
          clientRequestId: body.clientRequestId,
        },
        { transaction }
      );
      await RawMaterialRequestStatusHistory.create(
        {
          requestId: row.id,
          fromStatus: null,
          toStatus: STATUSES.PENDING_VALIDATION,
          changedBy: user.sub,
          changedByEmail: lower(user.email),
          comment: null,
        },
        { transaction }
      );
      return row;
    });
  } catch (err) {
    // Double clic simultané, ou autre demande du même vendredi enregistrée entre-temps.
    if (err instanceof UniqueConstraintError) {
      const again = await RawMaterialRequest.findOne({ where });
      if (again) return { request: toResponse(again), created: false };
      throw duplicateError(await findDayRequest({ userId: user.sub, poste: body.poste, date: day.date }));
    }
    throw err;
  }
  await notify.notifySubmitted(created);
  await notify.broadcastUpdated(created);
  await flagLateIfNeeded(created);
  return { request: toResponse(created), created: true };
}

/**
 * Correction d'une demande REJETÉE par son demandeur : nouvelles valeurs,
 * retour « En attente de validation », historisé (le rejet reste dans
 * l'historique) — jamais une seconde demande pour le même vendredi.
 */
async function resubmitRequest(user, id, body) {
  if (!UUID.test(String(id))) throw notFound();
  const row = await sequelize.transaction(async (transaction) => {
    const current = await RawMaterialRequest.findOne({ where: { id, userId: user.sub }, transaction, lock: true });
    if (!current) throw notFound();
    if (current.status !== STATUSES.REJECTED) {
      throw new RawMaterialRequestError(409, "NOT_REJECTED", "Seule une demande rejetée peut être corrigée et soumise à nouveau.");
    }
    const [n] = await RawMaterialRequest.update(
      {
        items: buildItems(body.items),
        status: STATUSES.PENDING_VALIDATION,
        rejectedAt: null,
        rejectedBy: null,
        rejectedByEmail: null,
        rejectionComment: null,
        lateNotifiedAt: null,
      },
      { where: { id, status: STATUSES.REJECTED }, transaction }
    );
    if (!n) throw new RawMaterialRequestError(409, "STATUS_CHANGED_CONCURRENTLY", "Le statut de cette demande vient d'être modifié. Rechargez la page.");
    await RawMaterialRequestStatusHistory.create(
      {
        requestId: id,
        fromStatus: STATUSES.REJECTED,
        toStatus: STATUSES.PENDING_VALIDATION,
        changedBy: user.sub,
        changedByEmail: lower(user.email),
        comment: "Demande corrigée et soumise à nouveau",
      },
      { transaction }
    );
    return RawMaterialRequest.findOne({ where: { id }, transaction });
  });
  await notify.notifySubmitted(row, { resubmitted: true });
  await notify.broadcastUpdated(row);
  await flagLateIfNeeded(row);
  return toResponse(row, { history: await historyOf(id), user });
}

// Gestionnaires et validateurs : toutes les demandes ; shift soir : les
// demandes validées (à prendre en charge ou déjà traitées) en plus des
// siennes ; les autres : les leurs.
function visibilityWhere(user) {
  if (cfg.isManager(user)) return {};
  if (cfg.isEveningHandler(user)) return { [Op.or]: [{ userId: user.sub }, { status: { [Op.in]: EVENING_VISIBLE_STATUSES } }] };
  return { userId: user.sub };
}

/** Transitions que CE compte peut effectuer (le backend revérifie à chaque changement). */
function transitionsFor(user) {
  const isManager = cfg.isManager(user);
  const isValidator = cfg.isValidator(user);
  return Object.fromEntries(
    Object.entries(TRANSITIONS).map(([from, tos]) => {
      if (from === STATUSES.PENDING_VALIDATION) return [from, isValidator ? tos : []];
      return [from, isManager ? tos : []];
    })
  );
}

function permissionsFor(user) {
  const isManager = cfg.isManager(user);
  const isRequester = cfg.requiredEmails.includes(lower(user?.email));
  const isEvening = cfg.isEveningHandler(user);
  return {
    canView: isManager || isRequester || isEvening,
    canEveningHandle: isEvening,
    fullVisibility: isManager,
    canManageStatus: isManager,
    canValidate: cfg.isValidator(user),
    statuses: Object.values(STATUSES),
    transitions: transitionsFor(user),
    materials: cfg.MATERIALS,
  };
}

/** Filtres communs à la liste et à l'export Excel. */
function buildListWhere(user, { module, poste, from, to, userId, material, status, search, toProcess } = {}) {
  const where = { ...visibilityWhere(user) };
  if (module) where.module = module;
  if (poste) where.poste = poste;
  if (status) where.status = status;
  // « Demandes à valider » : toutes les demandes sans décision, quel que
  // soit le demandeur (jamais filtré sur le compte du responsable).
  if (toProcess) where.status = status && AWAITING_DECISION_STATUSES.includes(status) ? status : { [Op.in]: AWAITING_DECISION_STATUSES };
  // Filtre utilisateur : uniquement dans le périmètre visible (jamais d'élargissement).
  if (userId && !where.userId) where.userId = userId;
  if (from || to) {
    where.requestDate = {};
    if (from) where.requestDate[Op.gte] = from;
    if (to) where.requestDate[Op.lte] = to;
  }
  if (material) where.items = { [Op.contains]: [{ material }] };
  const term = String(search || "").trim();
  if (term) where.requestNumber = { [Op.iLike]: `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%` };
  return where;
}

async function listRequests(user, filters = {}) {
  const limit = Math.min(Math.max(Number(filters.pageSize) || 50, 1), 200);
  const offset = (Math.max(Number(filters.page) || 1, 1) - 1) * limit;
  const { rows, count } = await RawMaterialRequest.findAndCountAll({
    where: buildListWhere(user, filters),
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });
  return { data: rows.map((r) => toResponse(r)), total: count };
}

/**
 * Popup, page « Demandes à valider » et badge du responsable : demandes sans
 * décision (en attente ou soumises), dont en retard / à échéance proche
 * (seules les demandes du vendredi ont une échéance).
 */
async function pendingSummary(user) {
  if (!cfg.isManager(user)) return { pending: 0, overdue: 0, dueSoon: 0 };
  const now = cfg.clock();
  const soon = new Date(now.getTime() + cfg.dueSoonMinutes * 60 * 1000);
  const deadline = { status: STATUSES.PENDING_VALIDATION };
  const [pending, overdue, dueSoon] = await Promise.all([
    RawMaterialRequest.count({ where: { status: { [Op.in]: AWAITING_DECISION_STATUSES } } }),
    RawMaterialRequest.count({ where: { ...deadline, deadlineAt: { [Op.lte]: now } } }),
    RawMaterialRequest.count({ where: { ...deadline, deadlineAt: { [Op.gt]: now, [Op.lte]: soon } } }),
  ]);
  return { pending, overdue, dueSoon };
}

/** Demandeurs présents dans le périmètre visible (filtre « Utilisateur »). */
async function listRequesters(user) {
  const rows = await RawMaterialRequest.findAll({
    where: visibilityWhere(user),
    attributes: ["userId", "userEmail"],
    group: ["userId", "userEmail"],
    order: [["userEmail", "ASC"]],
    raw: true,
  });
  return rows.map((r) => ({ userId: r.userId, userEmail: r.userEmail }));
}

async function historyOf(requestId, transaction) {
  return RawMaterialRequestStatusHistory.findAll({
    where: { requestId },
    order: [["createdAt", "ASC"]],
    transaction,
  });
}

async function getRequest(user, id) {
  if (!UUID.test(String(id))) throw notFound();
  const row = await RawMaterialRequest.findOne({ where: { id, ...visibilityWhere(user) } });
  if (!row) throw notFound();
  return toResponse(row, { history: await historyOf(row.id), user });
}

/**
 * Changement de statut manuel, historisé (ancien / nouveau statut, auteur,
 * date, commentaire). Une demande EN ATTENTE ne peut être validée ou rejetée
 * que par un validateur (responsable logistique achats) ; personne ne peut
 * statuer sur sa propre demande. Les autres transitions restent réservées
 * aux gestionnaires.
 */
async function changeStatus(user, id, { status, comment, expectedStatus }) {
  if (!UUID.test(String(id))) throw notFound();
  const result = await sequelize.transaction(async (transaction) => {
    const row = await RawMaterialRequest.findOne({ where: { id, ...visibilityWhere(user) }, transaction, lock: true });
    if (!row) throw notFound();

    const from = row.status;
    // Décision prise sur un statut périmé (un autre responsable a déjà décidé) :
    // refusée, jamais appliquée par-dessus la décision précédente.
    if (expectedStatus && expectedStatus !== from) {
      throw new RawMaterialRequestError(
        409,
        "STATUS_CHANGED_CONCURRENTLY",
        `Cette demande a déjà été traitée (statut actuel : « ${STATUS_LABELS[from] || from} »). Rechargez la page.`
      );
    }
    if (row.userId === user.sub) {
      throw new RawMaterialRequestError(403, "OWN_REQUEST", "Vous ne pouvez pas changer le statut de votre propre demande.");
    }
    if (from === STATUSES.PENDING_VALIDATION && !cfg.isValidator(user)) {
      throw new RawMaterialRequestError(
        403,
        "NOT_VALIDATOR",
        "Seul le responsable logistique achats peut valider ou rejeter une demande en attente."
      );
    }
    if (from !== STATUSES.PENDING_VALIDATION && !cfg.isManager(user)) {
      throw new RawMaterialRequestError(403, "PERMISSION_DENIED", "Vous n'êtes pas autorisé à modifier le statut de cette demande.");
    }
    if (!(TRANSITIONS[from] || []).includes(status)) {
      throw new RawMaterialRequestError(
        409,
        "INVALID_STATUS_TRANSITION",
        `Passage impossible de « ${STATUS_LABELS[from] || from} » à « ${STATUS_LABELS[status] || status} ».`
      );
    }

    const email = lower(user.email);
    const at = cfg.clock();
    const text = comment ? String(comment).trim() || null : null;
    // Un rejet doit toujours être motivé (le demandeur doit savoir quoi corriger).
    if (status === STATUSES.REJECTED && !text) {
      throw new RawMaterialRequestError(400, "REJECTION_COMMENT_REQUIRED", "Le motif du rejet est obligatoire.");
    }
    const changes = { status };
    if (status === STATUSES.VALIDATED) Object.assign(changes, { validatedAt: at, validatedBy: user.sub, validatedByEmail: email });
    if (status === STATUSES.REJECTED) {
      Object.assign(changes, { rejectedAt: at, rejectedBy: user.sub, rejectedByEmail: email, rejectionComment: text });
    }
    // Condition sur l'ancien statut : deux changements simultanés ne s'écrasent jamais.
    const [updated] = await RawMaterialRequest.update(changes, { where: { id, status: from }, transaction });
    if (!updated) {
      throw new RawMaterialRequestError(409, "STATUS_CHANGED_CONCURRENTLY", "Le statut de cette demande vient d'être modifié. Rechargez la page.");
    }
    await RawMaterialRequestStatusHistory.create(
      { requestId: id, fromStatus: from, toStatus: status, changedBy: user.sub, changedByEmail: email, comment: text },
      { transaction }
    );
    const fresh = await RawMaterialRequest.findOne({ where: { id }, transaction });
    return { fresh, history: await historyOf(id, transaction), from, text, email };
  });
  // Décision du responsable (validation / rejet d'une demande sans décision) : demandeur notifié.
  if (AWAITING_DECISION_STATUSES.includes(result.from) && [STATUSES.VALIDATED, STATUSES.REJECTED].includes(status)) {
    await notify.notifyDecision(result.fresh, { status, comment: result.text, byEmail: result.email });
  }
  await notify.broadcastUpdated(result.fresh);
  return toResponse(result.fresh, { history: result.history, user });
}

/**
 * Shift soir — prise en charge d'une demande VALIDÉE : quantités réelles de
 * chaque matière (obligatoires, 0 accepté), auteur, date ; statut « Acceptée
 * par le shift soir ». Les lignes validées et la validation logistique ne
 * sont jamais modifiées. Une seule prise en charge possible.
 */
async function eveningAccept(user, id, { actualItems }) {
  if (!UUID.test(String(id))) throw notFound();
  if (!cfg.isEveningHandler(user)) {
    throw new RawMaterialRequestError(403, "NOT_EVENING_HANDLER", "Seul le shift soir peut prendre en charge une demande validée.");
  }
  const result = await sequelize.transaction(async (transaction) => {
    const row = await RawMaterialRequest.findOne({ where: { id, ...visibilityWhere(user) }, transaction, lock: true });
    if (!row) throw notFound();
    assertEveningHandleable(row, user);

    // Une quantité réelle par matière de la demande, ni plus ni moins.
    const requested = (row.items || []).map((i) => i.material);
    const given = new Map(actualItems.map((a) => [a.material, a.quantiteReelle]));
    const missing = requested.filter((m) => !given.has(m));
    const extra = [...given.keys()].filter((m) => !requested.includes(m));
    if (missing.length || extra.length) {
      throw new RawMaterialRequestError(
        400,
        "ACTUAL_QUANTITIES_MISMATCH",
        missing.length
          ? `Quantité réelle manquante pour : ${missing.join(", ")}.`
          : `Matière absente de la demande : ${extra.join(", ")}.`
      );
    }
    const actual = (row.items || []).map((i) => ({ material: i.material, label: i.label, quantiteReelle: given.get(i.material), unite: cfg.UNIT }));
    const at = cfg.clock();
    const email = lower(user.email);
    const [n] = await RawMaterialRequest.update(
      { status: STATUSES.EVENING_ACCEPTED, actualItems: actual, eveningHandledAt: at, eveningHandledBy: user.sub, eveningHandledByEmail: email },
      { where: { id, status: STATUSES.VALIDATED }, transaction }
    );
    if (!n) throw alreadyHandled();
    await RawMaterialRequestStatusHistory.create(
      {
        requestId: id,
        fromStatus: STATUSES.VALIDATED,
        toStatus: STATUSES.EVENING_ACCEPTED,
        changedBy: user.sub,
        changedByEmail: email,
        comment: `Prise en charge par le shift soir — quantités réelles : ${actual.map((a) => `${a.label} ${a.quantiteReelle} ${a.unite}`).join(", ")}`,
      },
      { transaction }
    );
    return RawMaterialRequest.findOne({ where: { id }, transaction });
  });
  await notify.broadcastUpdated(result);
  return toResponse(result, { history: await historyOf(id), user });
}

/** Shift soir — refus motivé d'une demande validée ; le responsable logistique est notifié. */
async function eveningRefuse(user, id, { comment }) {
  if (!UUID.test(String(id))) throw notFound();
  if (!cfg.isEveningHandler(user)) {
    throw new RawMaterialRequestError(403, "NOT_EVENING_HANDLER", "Seul le shift soir peut refuser une demande validée.");
  }
  const text = String(comment || "").trim();
  if (!text) throw new RawMaterialRequestError(400, "REFUSAL_COMMENT_REQUIRED", "Le motif du refus est obligatoire.");
  const result = await sequelize.transaction(async (transaction) => {
    const row = await RawMaterialRequest.findOne({ where: { id, ...visibilityWhere(user) }, transaction, lock: true });
    if (!row) throw notFound();
    assertEveningHandleable(row, user);
    const at = cfg.clock();
    const email = lower(user.email);
    const [n] = await RawMaterialRequest.update(
      { status: STATUSES.EVENING_REFUSED, eveningRefusalComment: text, eveningHandledAt: at, eveningHandledBy: user.sub, eveningHandledByEmail: email },
      { where: { id, status: STATUSES.VALIDATED }, transaction }
    );
    if (!n) throw alreadyHandled();
    await RawMaterialRequestStatusHistory.create(
      { requestId: id, fromStatus: STATUSES.VALIDATED, toStatus: STATUSES.EVENING_REFUSED, changedBy: user.sub, changedByEmail: email, comment: text },
      { transaction }
    );
    return RawMaterialRequest.findOne({ where: { id }, transaction });
  });
  await notify.notifyEveningRefused(result, { comment: text, byEmail: lower(user.email) });
  await notify.broadcastUpdated(result);
  return toResponse(result, { history: await historyOf(id), user });
}

const alreadyHandled = () =>
  new RawMaterialRequestError(409, "ALREADY_HANDLED", "Cette demande a déjà été traitée (ou son statut vient de changer). Rechargez la page.");

function assertEveningHandleable(row, user) {
  if (row.userId === user.sub) {
    throw new RawMaterialRequestError(403, "OWN_REQUEST", "Vous ne pouvez pas prendre en charge votre propre demande.");
  }
  if (row.status !== STATUSES.VALIDATED) {
    if ([STATUSES.EVENING_ACCEPTED, STATUSES.EVENING_REFUSED, STATUSES.PROCESSED].includes(row.status)) throw alreadyHandled();
    throw new RawMaterialRequestError(
      409,
      "NOT_VALIDATED",
      "Seule une demande validée par le responsable logistique peut être prise en charge par le shift soir."
    );
  }
}

/** Lignes de l'export (une par matière), mêmes filtres et droits que la liste. */
async function exportRows(user, filters = {}) {
  const rows = await RawMaterialRequest.findAll({
    where: buildListWhere(user, filters),
    order: [["createdAt", "DESC"]],
    limit: 20000,
  });
  return rows.map((r) => toResponse(r));
}

/**
 * Création d'une fiche le vendredi : la demande active de ce vendredi (même
 * utilisateur, même poste) — en attente, validée ou en traitement. Elle vaut
 * pour toutes les fiches du jour (elle n'est plus « consommée » par fiche).
 */
async function findActiveRequestForFiche({ userId, poste }) {
  const row = await findDayRequest({ userId, poste, date: cfg.dayContext(cfg.clock()).date });
  return isActive(row) ? row : null;
}

// Première fiche créée grâce à la demande : rattachée pour la traçabilité.
async function linkToFiche(id, { ficheType, ficheId }) {
  await RawMaterialRequest.update({ ficheType, ficheId, consumedAt: cfg.clock() }, { where: { id, ficheId: null } });
}

/**
 * Alerte de retard : demandes encore en attente après l'échéance, signalées
 * une seule fois (lateNotifiedAt). Le statut ne change pas : jamais de
 * validation automatique.
 */
async function sweepLate() {
  const now = cfg.clock();
  const rows = await RawMaterialRequest.findAll({
    where: { status: STATUSES.PENDING_VALIDATION, deadlineAt: { [Op.lte]: now }, lateNotifiedAt: null },
  });
  let notified = 0;
  for (const row of rows) {
    const [n] = await RawMaterialRequest.update({ lateNotifiedAt: now }, { where: { id: row.id, lateNotifiedAt: null } });
    if (!n) continue; // déjà signalée par un autre passage
    await notify.notifyLate(row);
    notified++;
  }
  return { checked: rows.length, notified };
}

module.exports = {
  RawMaterialRequestError,
  STATUS_LABELS,
  requirementFor,
  sessionRequirement,
  createRequest,
  resubmitRequest,
  permissionsFor,
  listRequests,
  pendingSummary,
  listRequesters,
  getRequest,
  changeStatus,
  eveningAccept,
  eveningRefuse,
  exportRows,
  findActiveRequestForFiche,
  linkToFiche,
  sweepLate,
};
