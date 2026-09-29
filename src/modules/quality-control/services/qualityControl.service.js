"use strict";

// Module CONTRÔLE QUALITÉ — checklist de production (15 paramètres) remplie
// par le rôle controle_qualite sur une fiche PROMESH ou PROBAR existante.
//
// Règles clés :
// - la fiche contrôlée est LUE (jamais modifiée) — lecture directe des
//   modèles, sans passer par les services PROMESH/PROBAR (qui ont des effets
//   de bord à la lecture, ex. auto-validation > 24h) ;
// - date/heure/utilisateur du contrôle posés par le SERVEUR (heure de Tunisie),
//   jamais acceptés du client ;
// - toute modification d'un paramètre ou du statut est journalisée champ par
//   champ (ancienne → nouvelle valeur) dans quality_control_history ;
// - un contrôle déjà validé ne peut être modifié qu'avec un motif explicite
//   (changeReason) — jamais écrasé silencieusement ;
// - un paramètre NON CONFORME force le statut global NON CONFORME et
//   déclenche une notification interne aux responsables (jamais d'email client).

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { Op } = require("sequelize");

dayjs.extend(utc);
dayjs.extend(timezone);

const { sequelize } = require("../../../db");
const cfg = require("../../../config/qualityControl");
const User = require("../../../models/User");
const Notification = require("../../../models/Notification");
const PorPromesh = require("../../../models/PorPromesh");
const IndustrialRecord = require("../../../models/IndustrialRecord");
const QualityControl = require("../../../models/QualityControl");
const QualityControlItem = require("../../../models/QualityControlItem");
const QualityControlHistory = require("../../../models/QualityControlHistory");
const { normalizePromesh, normalizeProbar } = require("../../production-records/dto/productionRecords.dto");
const { emitToUser } = require("../../../socket");
const logger = require("../../../utils/logger");
require("../../../models/associations");

const STATUS = Object.freeze({
  EN_ATTENTE: "EN_ATTENTE",
  EN_COURS: "EN_COURS",
  CONFORME: "CONFORME",
  NON_CONFORME: "NON_CONFORME",
});
const ITEM_STATUS = Object.freeze({
  CONFORME: "CONFORME",
  NON_CONFORME: "NON_CONFORME",
  NON_CONTROLE: "NON_CONTROLE",
});
const PARAM_BY_KEY = new Map(cfg.parameters.map((p) => [p.key, p]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Heure de Tunisie ─────────────────────────────────────────────────────

let clock = () => new Date();
// Tests uniquement — permet de figer l'instant "maintenant".
const setClock = (fn) => {
  clock = fn || (() => new Date());
};
const tz = (d) => dayjs(d).tz(cfg.timezone);

// ── Portée / permissions (RBAC existant : rôle issu du JWT) ──────────────

function isOwnerScoped(actor) {
  return actor.role === cfg.role;
}

function scopeWhere(actor) {
  return isOwnerScoped(actor) ? { controllerUserId: actor.id } : {};
}

// ── Fiche de production contrôlée ────────────────────────────────────────

// Accepte l'id composite de /production-records ("promesh:<uuid>") OU un
// couple (productionType, uuid).
function parseProductionRef(ref, productionType) {
  const raw = String(ref || "").trim();
  let type = productionType ? String(productionType).trim().toUpperCase() : null;
  let uuid = raw;
  if (raw.includes(":")) {
    const [prefix, id] = raw.split(":");
    type = String(prefix).toUpperCase();
    uuid = id;
  }
  if (!["PROMESH", "PROBAR"].includes(type)) {
    throw { status: 400, code: "INVALID_PRODUCTION_TYPE", message: "Type de production invalide (PROMESH ou PROBAR attendu)" };
  }
  if (!UUID_RE.test(uuid || "")) {
    throw { status: 400, code: "INVALID_PRODUCTION_RECORD", message: "Identifiant de fiche de production invalide" };
  }
  return { type, uuid };
}

// Instantané de la fiche via le DTO "Fiches de production" existant (même
// numéro lisible "PROMESH-2026-000449" / "PROBAR-2026-XXXXXX" qu'ailleurs).
async function loadFicheSnapshot(type, uuid, transaction) {
  if (type === "PROMESH") {
    const fiche = await PorPromesh.findByPk(uuid, { transaction });
    if (!fiche) throw { status: 404, code: "FICHE_NOT_FOUND", message: "Fiche de production introuvable" };
    const n = normalizePromesh(fiche);
    return { productionRecordId: fiche.id, productionType: type, ficheNumero: n.numero, machine: n.machine, poste: n.poste, productionDate: n.date };
  }
  const fiche = await IndustrialRecord.findOne({ where: { id: uuid, module: "probar" }, transaction });
  if (!fiche) throw { status: 404, code: "FICHE_NOT_FOUND", message: "Fiche de production introuvable" };
  const n = normalizeProbar(fiche);
  return { productionRecordId: fiche.id, productionType: type, ficheNumero: n.numero, machine: n.machine, poste: n.poste, productionDate: n.date };
}

// ── DTO ──────────────────────────────────────────────────────────────────

function machineLabel(machine) {
  if (machine == null || machine === "") return null;
  return /^\d+$/.test(String(machine)) ? `Machine ${machine}` : String(machine);
}

function posteLabel(poste) {
  if (!poste) return null;
  return String(poste).charAt(0).toUpperCase() + String(poste).slice(1);
}

function isValidated(control) {
  return control.validatedAt != null;
}

function computeCounts(items) {
  const controlled = items.filter((i) => i.status !== ITEM_STATUS.NON_CONTROLE);
  const nonConformes = items.filter((i) => i.status === ITEM_STATUS.NON_CONFORME);
  return {
    total: cfg.parameters.length,
    controlled: controlled.length,
    conformes: controlled.length - nonConformes.length,
    nonConformes: nonConformes.length,
  };
}

function toItemResponse(item) {
  const i = item.toJSON ? item.toJSON() : item;
  const param = PARAM_BY_KEY.get(i.parameterKey);
  return {
    id: i.id,
    parameterKey: i.parameterKey,
    parameterName: i.parameterName,
    position: i.position,
    autoTime: Boolean(param?.autoTime),
    value: i.value,
    status: i.status,
    remark: i.remark,
    checkedAt: i.checkedAt,
    checkedBy: i.checkedBy,
    checkedByEmail: i.checkedByEmail,
  };
}

function toHistoryResponse(h) {
  const r = h.toJSON ? h.toJSON() : h;
  const at = tz(r.changedAt);
  return {
    id: r.id,
    action: r.action,
    parameterKey: r.parameterKey,
    parameterName: r.parameterKey ? PARAM_BY_KEY.get(r.parameterKey)?.label || r.parameterKey : null,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    reason: r.reason,
    userId: r.userId,
    userEmail: r.userEmail,
    changedAt: r.changedAt,
    changedDate: at.format("DD/MM/YYYY"),
    changedTime: at.format("HH:mm:ss"),
  };
}

function toControlResponse(control, items, { history } = {}) {
  const c = control.toJSON ? control.toJSON() : control;
  const sortedItems = [...items].sort((a, b) => a.position - b.position);
  const shown = tz(c.checkedAt || c.createdAt);
  return {
    id: c.id,
    productionRecordId: c.productionRecordId,
    productionType: c.productionType,
    // Id composite directement utilisable avec GET /production-records/:id.
    productionRecordRef: `${String(c.productionType).toLowerCase()}:${c.productionRecordId}`,
    ficheNumero: c.ficheNumero,
    machine: c.machine,
    machineLabel: machineLabel(c.machine),
    poste: c.poste,
    posteLabel: posteLabel(c.poste),
    productionDate: c.productionDate,
    controllerUserId: c.controllerUserId,
    controllerEmail: c.controllerEmail,
    status: c.status,
    remark: c.remark,
    isValidated: isValidated(c),
    checkedAt: c.checkedAt,
    // Date/heure du contrôle en heure de Tunisie — validation si faite,
    // sinon ouverture du contrôle (EN_ATTENTE / EN_COURS).
    controlDate: c.controlDate ? dayjs(c.controlDate).format("DD/MM/YYYY") : shown.format("DD/MM/YYYY"),
    controlTime: c.controlTime ? String(c.controlTime).slice(0, 8) : shown.format("HH:mm:ss"),
    validatedAt: c.validatedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    counts: computeCounts(sortedItems),
    nonConformParameters: sortedItems.filter((i) => i.status === ITEM_STATUS.NON_CONFORME).map((i) => i.parameterName),
    ...(history !== undefined
      ? { items: sortedItems.map(toItemResponse), history: history.map(toHistoryResponse) }
      : {}),
  };
}

// ── Journal ──────────────────────────────────────────────────────────────

function asText(v) {
  return v == null ? null : String(v);
}

function historyRow(control, actor, fields) {
  return {
    qualityControlId: control.id,
    userId: actor.id,
    userEmail: actor.email,
    changedAt: clock(),
    ...fields,
    oldValue: asText(fields.oldValue),
    newValue: asText(fields.newValue),
  };
}

// ── Application des saisies ──────────────────────────────────────────────

function normalizeText(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Applique les modifications demandées aux paramètres (sans les enregistrer)
// et retourne les lignes d'historique correspondantes. Seuls les champs
// réellement présents dans la requête ET différents de la valeur actuelle
// sont touchés — un champ absent n'est jamais remis à zéro.
function applyItemChanges(control, items, inputs, actor, reason) {
  const byKey = new Map(items.map((i) => [i.parameterKey, i]));
  const history = [];
  const touched = new Set();
  const now = clock();

  for (const input of inputs || []) {
    const item = byKey.get(input.parameterKey);
    if (!item) {
      throw { status: 400, code: "UNKNOWN_PARAMETER", message: `Paramètre inconnu : ${input.parameterKey}` };
    }
    const next = {
      value: normalizeText(input.value),
      status: input.status,
      remark: normalizeText(input.remark),
    };
    for (const field of ["value", "status", "remark"]) {
      if (next[field] === undefined) continue;
      if ((item[field] ?? null) === (next[field] ?? null)) continue;
      history.push(
        historyRow(control, actor, {
          action: "UPDATE",
          parameterKey: item.parameterKey,
          field,
          oldValue: item[field],
          newValue: next[field],
          reason: reason || null,
        })
      );
      item[field] = next[field];
      touched.add(item);
    }
  }

  for (const item of touched) {
    item.checkedAt = now;
    item.checkedBy = actor.id;
    item.checkedByEmail = actor.email;
  }
  return { history, touched: [...touched] };
}

function hasAnyInput(items) {
  return items.some((i) => i.status !== ITEM_STATUS.NON_CONTROLE || i.value != null || i.remark != null);
}

// Champs obligatoires d'un contrôle validé — renvoie la liste des erreurs
// par paramètre (vide = OK).
function collectValidationErrors(items, { status, remark }) {
  const errors = [];
  const controlled = items.filter((i) => i.status !== ITEM_STATUS.NON_CONTROLE);
  if (controlled.length === 0) {
    errors.push({ parameterKey: null, message: "Au moins un paramètre doit être contrôlé (Conforme ou Non conforme)" });
  }
  for (const i of items) {
    const param = PARAM_BY_KEY.get(i.parameterKey);
    if (i.status !== ITEM_STATUS.NON_CONTROLE && i.value == null) {
      errors.push({ parameterKey: i.parameterKey, message: `${i.parameterName} : valeur obligatoire pour un paramètre contrôlé` });
    }
    if (i.status === ITEM_STATUS.NON_CONFORME && i.remark == null) {
      errors.push({ parameterKey: i.parameterKey, message: `${i.parameterName} : remarque obligatoire pour expliquer la non-conformité` });
    }
    if (!param?.autoTime && i.status === ITEM_STATUS.NON_CONTROLE && i.value != null) {
      errors.push({ parameterKey: i.parameterKey, message: `${i.parameterName} : indiquer Conforme ou Non conforme pour la valeur saisie` });
    }
  }
  const anyNc = items.some((i) => i.status === ITEM_STATUS.NON_CONFORME);
  if (status === STATUS.NON_CONFORME && !anyNc && !remark) {
    errors.push({ parameterKey: null, message: "Remarque générale obligatoire pour un contrôle NON CONFORME sans paramètre non conforme" });
  }
  return errors;
}

// Statut global d'un contrôle validé : un paramètre NON CONFORME force
// NON_CONFORME ; sinon le résultat choisi par le contrôleur (défaut :
// statut actuel, puis CONFORME). Une non-conformité n'est jamais levée
// automatiquement — repasser à CONFORME exige un choix explicite.
function resolveGlobalStatus(items, requested, current) {
  if (items.some((i) => i.status === ITEM_STATUS.NON_CONFORME)) return STATUS.NON_CONFORME;
  if (requested === STATUS.CONFORME || requested === STATUS.NON_CONFORME) return requested;
  if (current === STATUS.CONFORME || current === STATUS.NON_CONFORME) return current;
  return STATUS.CONFORME;
}

// ── Lecture ──────────────────────────────────────────────────────────────

async function loadControlForActor(id, actor, { transaction, lock } = {}) {
  if (!UUID_RE.test(String(id || ""))) throw { status: 404, code: "NOT_FOUND", message: "Contrôle qualité introuvable" };
  const control = await QualityControl.findByPk(id, { transaction, lock: lock ? transaction.LOCK.UPDATE : undefined });
  if (!control) throw { status: 404, code: "NOT_FOUND", message: "Contrôle qualité introuvable" };
  if (isOwnerScoped(actor) && control.controllerUserId !== actor.id) {
    throw { status: 403, code: "NOT_OWNER", message: "Vous ne pouvez accéder qu'à vos propres contrôles qualité" };
  }
  return control;
}

async function loadItems(controlId, transaction) {
  return QualityControlItem.findAll({ where: { qualityControlId: controlId }, order: [["position", "ASC"]], transaction });
}

async function withItemsForList(controls) {
  if (controls.length === 0) return [];
  const items = await QualityControlItem.findAll({
    where: { qualityControlId: controls.map((c) => c.id) },
    attributes: ["qualityControlId", "parameterKey", "parameterName", "position", "status"],
  });
  const grouped = new Map();
  for (const i of items) {
    if (!grouped.has(i.qualityControlId)) grouped.set(i.qualityControlId, []);
    grouped.get(i.qualityControlId).push(i.toJSON());
  }
  return controls.map((c) => toControlResponse(c, grouped.get(c.id) || []));
}

function tunisDayStart(dateStr) {
  const d = dayjs.tz(String(dateStr), "YYYY-MM-DD", cfg.timezone);
  if (!d.isValid()) throw { status: 400, code: "INVALID_DATE", message: "Date invalide (AAAA-MM-JJ attendu)" };
  return d;
}

async function listControls(filters, actor) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(filters.limit, 10) || 20));
  const where = scopeWhere(actor);

  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.productionType) where.productionType = String(filters.productionType).toUpperCase();
  if (filters.machine) where.machine = String(filters.machine);
  if (filters.poste) where.poste = String(filters.poste);
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt[Op.gte] = tunisDayStart(filters.from).toDate();
    if (filters.to) where.createdAt[Op.lt] = tunisDayStart(filters.to).add(1, "day").toDate();
  }
  if (filters.search) where.ficheNumero = { [Op.iLike]: `%${filters.search}%` };

  const { count, rows } = await QualityControl.findAndCountAll({
    where,
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });

  return {
    data: await withItemsForList(rows),
    pagination: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
}

async function getControlById(id, actor) {
  const control = await loadControlForActor(id, actor);
  const [items, history] = await Promise.all([
    loadItems(control.id),
    QualityControlHistory.findAll({ where: { qualityControlId: control.id }, order: [["changedAt", "ASC"], ["id", "ASC"]] }),
  ]);
  return toControlResponse(control, items, { history });
}

async function listByProductionRecord(ref, productionType, actor) {
  const { type, uuid } = parseProductionRef(ref, productionType);
  const rows = await QualityControl.findAll({
    where: { ...scopeWhere(actor), productionType: type, productionRecordId: uuid },
    order: [["createdAt", "DESC"]],
  });
  return withItemsForList(rows);
}

// ── Écriture ─────────────────────────────────────────────────────────────

async function createControl(body, actor) {
  const { type, uuid } = parseProductionRef(body.productionRecordId, body.productionType);

  const result = await sequelize.transaction(async (transaction) => {
    const snapshot = await loadFicheSnapshot(type, uuid, transaction);
    const control = await QualityControl.create(
      {
        ...snapshot,
        controllerUserId: actor.id,
        controllerEmail: actor.email,
        status: STATUS.EN_ATTENTE,
        remark: normalizeText(body.remark) ?? null,
      },
      { transaction }
    );

    const items = await QualityControlItem.bulkCreate(
      cfg.parameters.map((p) => ({
        qualityControlId: control.id,
        parameterKey: p.key,
        parameterName: p.label,
        position: p.position,
        status: ITEM_STATUS.NON_CONTROLE,
      })),
      { transaction, returning: true }
    );

    const history = [
      historyRow(control, actor, { action: "CREATE", field: "status", newValue: STATUS.EN_ATTENTE }),
    ];
    const applied = applyItemChanges(control, items, body.items, actor);
    history.push(...applied.history);
    for (const item of applied.touched) await item.save({ transaction });

    if (hasAnyInput(items)) {
      history.push(historyRow(control, actor, { action: "STATUS_CHANGE", field: "status", oldValue: control.status, newValue: STATUS.EN_COURS }));
      control.status = STATUS.EN_COURS;
      await control.save({ transaction });
    }

    await QualityControlHistory.bulkCreate(history, { transaction });
    return control;
  });

  return getControlById(result.id, actor);
}

// Partagé par PUT (update) et POST /validate — `validate: true` fait passer
// un contrôle EN_ATTENTE/EN_COURS à CONFORME/NON_CONFORME avec horodatage.
async function saveControl(id, body, actor, { validate }) {
  let notifyNc = false;

  const controlId = await sequelize.transaction(async (transaction) => {
    const control = await loadControlForActor(id, actor, { transaction, lock: true });
    const alreadyValidated = isValidated(control);

    if (validate && alreadyValidated) {
      throw { status: 409, code: "ALREADY_VALIDATED", message: "Ce contrôle qualité est déjà validé — utilisez la modification avec motif" };
    }

    const reason = normalizeText(body.changeReason) ?? null;
    const items = await loadItems(control.id, transaction);
    const applied = applyItemChanges(control, items, body.items, actor, alreadyValidated ? reason : null);
    const history = [...applied.history];

    const nextRemark = normalizeText(body.remark);
    if (nextRemark !== undefined && (control.remark ?? null) !== (nextRemark ?? null)) {
      history.push(historyRow(control, actor, { action: "UPDATE", field: "remark", oldValue: control.remark, newValue: nextRemark, reason: alreadyValidated ? reason : null }));
      control.remark = nextRemark;
    }

    const previousStatus = control.status;
    let nextStatus = previousStatus;

    if (validate || alreadyValidated) {
      if (validate) {
        // HEURE : pré-remplie avec l'heure de Tunisie du contrôle si vide.
        const now = tz(clock());
        for (const item of items) {
          if (PARAM_BY_KEY.get(item.parameterKey)?.autoTime && item.value == null) {
            history.push(historyRow(control, actor, { action: "UPDATE", parameterKey: item.parameterKey, field: "value", oldValue: null, newValue: now.format("HH:mm") }));
            item.value = now.format("HH:mm");
            item.checkedAt = clock();
            item.checkedBy = actor.id;
            item.checkedByEmail = actor.email;
            applied.touched.push(item);
          }
        }
      }
      nextStatus = resolveGlobalStatus(items, body.status, alreadyValidated ? previousStatus : null);
      const errors = collectValidationErrors(items, { status: nextStatus, remark: control.remark });
      if (errors.length) {
        throw { status: 422, code: "VALIDATION_FAILED", message: "Champs obligatoires manquants", errors };
      }
    } else {
      nextStatus = hasAnyInput(items) ? STATUS.EN_COURS : STATUS.EN_ATTENTE;
    }

    const changed = history.length > 0 || nextStatus !== previousStatus;
    // Contrôle déjà validé : jamais d'écrasement silencieux — motif obligatoire.
    if (alreadyValidated && changed && !reason) {
      throw {
        status: 409,
        code: "CHANGE_REASON_REQUIRED",
        message: "Ce contrôle est déjà validé : un motif de modification est obligatoire",
      };
    }

    if (nextStatus !== previousStatus) {
      history.push(historyRow(control, actor, { action: "STATUS_CHANGE", field: "status", oldValue: previousStatus, newValue: nextStatus, reason: alreadyValidated ? reason : null }));
      control.status = nextStatus;
    }

    if (validate) {
      const now = clock();
      const local = tz(now);
      control.checkedAt = now;
      control.validatedAt = now;
      control.controlDate = local.format("YYYY-MM-DD");
      control.controlTime = local.format("HH:mm:ss");
      history.push(historyRow(control, actor, { action: "VALIDATE", field: "status", newValue: nextStatus }));
    }

    for (const item of new Set(applied.touched)) await item.save({ transaction });
    if (changed || validate) await control.save({ transaction });
    if (history.length) await QualityControlHistory.bulkCreate(history, { transaction });

    notifyNc = nextStatus === STATUS.NON_CONFORME && (validate || previousStatus !== STATUS.NON_CONFORME);
    return control.id;
  });

  const response = await getControlById(controlId, actor);
  if (notifyNc) response.notificationsSent = await notifyNonConformity(response, actor);
  return response;
}

function updateControl(id, body, actor) {
  return saveControl(id, body, actor, { validate: false });
}

function validateControl(id, body, actor) {
  return saveControl(id, body, actor, { validate: true });
}

// Suppression LOGIQUE uniquement (paranoid) — le contrôle, ses paramètres et
// son historique restent en base ; l'action est elle-même journalisée.
async function deleteControl(id, actor) {
  await sequelize.transaction(async (transaction) => {
    const control = await loadControlForActor(id, actor, { transaction, lock: true });
    await QualityControlHistory.create(historyRow(control, actor, { action: "DELETE", field: "status", oldValue: control.status }), { transaction });
    control.deletedBy = actor.id;
    await control.save({ transaction });
    await control.destroy({ transaction });
  });
  return { id };
}

// ── Notifications internes ───────────────────────────────────────────────

function buildNonConformityMessage(control) {
  const params = control.nonConformParameters.length ? control.nonConformParameters.join(", ") : "aucun (non-conformité globale)";
  return [
    `Production : ${control.productionType}`,
    `Machine : ${control.machineLabel || "—"}`,
    `Fiche : ${control.ficheNumero || "—"}`,
    `Date : ${control.controlDate} ${control.controlTime}`,
    `Contrôleur : ${control.controllerEmail}`,
    `Paramètre(s) non conforme(s) : ${params}`,
  ].join(" · ");
}

// Notification interne (table notifications + socket) aux responsables
// Production — jamais d'email, jamais le client. Un échec n'annule jamais le
// contrôle déjà enregistré : il est seulement journalisé.
async function notifyNonConformity(control, actor) {
  try {
    const recipients = await User.findAll({
      where: { email: cfg.notifyRecipients, isActive: true },
      attributes: ["id", "email"],
    });
    const message = buildNonConformityMessage(control).slice(0, 500);
    let sent = 0;
    for (const user of recipients) {
      if (user.id === actor.id) continue;
      await Notification.create({
        userId: user.id,
        type: "QUALITY_CONTROL_NON_CONFORME",
        title: "Contrôle qualité non conforme",
        message,
        qualityControlId: control.id,
        isRead: false,
      });
      emitToUser(user.id, "quality-control-non-conforme", {
        qualityControlId: control.id,
        productionType: control.productionType,
        ficheNumero: control.ficheNumero,
        nonConformParameters: control.nonConformParameters,
      });
      sent += 1;
    }
    logger.info(`[QUALITY-CONTROL] non-conformité ${control.id} notifiée à ${sent} responsable(s)`);
    return sent;
  } catch (err) {
    logger.error(`[QUALITY-CONTROL] notification non-conformité échouée: ${err.message}`);
    return 0;
  }
}

function listParameters() {
  return cfg.parameters.map((p) => ({ key: p.key, label: p.label, position: p.position, autoTime: p.autoTime }));
}

module.exports = {
  STATUS,
  ITEM_STATUS,
  listParameters,
  listControls,
  getControlById,
  listByProductionRecord,
  createControl,
  updateControl,
  validateControl,
  deleteControl,
  setClock,
};
