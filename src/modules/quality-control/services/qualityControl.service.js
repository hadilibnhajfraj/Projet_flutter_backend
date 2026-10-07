"use strict";

// Module CONTRÔLE QUALITÉ — fiches de contrôle qualité d'une MACHINE
// (PROMESH / PROBAR + machine), créées par le rôle controle_qualite.
//
// Structure :
//   QualityControl (fiche : machine, date, poste, lot, ordre de fabrication,
//   contrôleur, statut global)
//     └─ QualityControlReading (PRÉLÈVEMENT : heure du contrôle, résultat)
//          └─ QualityControlItem (paramètre du prélèvement : valeur, statut, remarque)
// Une fiche porte PLUSIEURS prélèvements (08:00, 11:00, 14:00…) ; un nouveau
// prélèvement n'écrase jamais un prélèvement existant, et une même heure n'existe
// qu'une fois par fiche.
//
// Indépendant de la production dans l'interface : aucune fiche de production
// n'est demandée à l'utilisateur. Le SERVEUR associe automatiquement la fiche
// de production correspondante (ligne + machine + date de production +
// poste — voir qualityControlProduction.service) ; sans correspondance unique
// la fiche qualité est enregistrée sans production.
//
// Règles clés :
// - auteur (JWT) et horodatages de validation posés par le SERVEUR (heure de
//   Tunisie), jamais acceptés du client ;
// - toute modification est journalisée champ par champ (ancienne → nouvelle
//   valeur, heure du prélèvement) dans quality_control_history ;
// - PRÉLÈVEMENT : BROUILLON modifiable / supprimable ; VALIDÉ en lecture seule ;
// - FICHE : BROUILLON (prélèvements ajoutables) ; VALIDÉE = tout en lecture seule
//   (403) ;
// - un paramètre NON CONFORME force le résultat NON CONFORME du prélèvement, et
//   un prélèvement NON CONFORME celui de la fiche ; notification interne aux
//   responsables (jamais d'email client).

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { Op, QueryTypes } = require("sequelize");

dayjs.extend(utc);
dayjs.extend(timezone);

const { sequelize } = require("../../../db");
const cfg = require("../../../config/qualityControl");
const User = require("../../../models/User");
const Notification = require("../../../models/Notification");
const QualityControl = require("../../../models/QualityControl");
const QualityControlReading = require("../../../models/QualityControlReading");
const QualityControlItem = require("../../../models/QualityControlItem");
const QualityControlHistory = require("../../../models/QualityControlHistory");
const { emitToUser } = require("../../../socket");
const logger = require("../../../utils/logger");
const { findProductionForQualityControl, readProductionInfo } = require("./qualityControlProduction.service");
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
// Contrôles TEMPORELS d'un prélèvement (les paramètres physiques appartiennent à
// la fiche — voir physicalItems).
const PARAM_BY_KEY = new Map(cfg.readingParameters.map((p) => [p.key, p]));
const ALL_PARAM_LABELS = new Map(cfg.parameters.map((p) => [p.key, p.label]));

// Date/heure EFFECTIVES d'un contrôle = date + heure d'ouverture choisies
// par le contrôleur (affichées partout) ; à défaut (anciens contrôles),
// création en heure de Tunis. UNE seule définition, utilisée par la liste,
// les filtres de période, les statistiques et le « dernier contrôle » :
// toutes les pages comptent et classent les mêmes lignes de la même façon.
const EFFECTIVE_TS_SQL = `COALESCE("controlDate" + "controlTime", ("createdAt" AT TIME ZONE '${cfg.timezone}'))`;
const EFFECTIVE_ORDER = [
  [sequelize.literal(EFFECTIVE_TS_SQL), "DESC"],
  ["createdAt", "DESC"],
];
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

// Périmètre du module : UNIQUEMENT les fiches créées par un compte
// controle_qualite (auteur = controllerUserId, posé depuis le JWT). Le rôle
// controle_qualite ne voit que les siennes ; les admins, celles de tous les
// comptes controle_qualite — jamais d'autres comptes (production…).
const QC_AUTHORS_SQL = `(SELECT id FROM users WHERE role = '${cfg.role}')`;

function scopeWhere(actor) {
  return isOwnerScoped(actor)
    ? { controllerUserId: actor.id }
    : { controllerUserId: { [Op.in]: sequelize.literal(QC_AUTHORS_SQL) } };
}

function scopeSqlFor(actor) {
  return isOwnerScoped(actor) ? `AND "controllerUserId" = :uid` : `AND "controllerUserId" IN ${QC_AUTHORS_SQL}`;
}

// Ligne + machine d'une fiche qualité : celles de la configuration (les
// machines du module Production), jamais une valeur libre.
function parseMachine(productionType, machine) {
  const type = String(productionType || "").trim().toUpperCase();
  const line = cfg.productionLines.find((l) => l.type === type);
  if (!line) throw { status: 400, code: "INVALID_PRODUCTION_TYPE", message: "Type de production invalide (PROMESH ou PROBAR attendu)" };
  const m = String(machine ?? "").trim();
  if (!line.machines.includes(m)) {
    throw { status: 400, code: "INVALID_MACHINE", message: `Machine inconnue pour ${type} : ${m || "—"} (machines : ${line.machines.join(", ")})` };
  }
  return { type, machine: m };
}

// Référence (étiquette) unique d'une fiche de contrôle qualité, générée par
// le SERVEUR à la première sauvegarde : QC-PROMESH-NNNNNN / QC-PROBAR-NNNNNN.
// - UN compteur par ligne : PROMESH et PROBAR ont chacun leur numérotation ;
// - incrémental : dernier numéro de la ligne + 1, sous verrou consultatif de
//   transaction propre à la ligne (deux créations simultanées ne reçoivent
//   jamais le même numéro) — jamais COUNT + 1 ;
// - jamais réutilisé : les fiches supprimées (suppression logique) restent
//   dans le calcul ;
// - distincte de la référence de production (PROMESH-2026-000953…).
// Les anciennes références (QC-AAAA-NNNNN) sont conservées telles quelles.
async function nextReference(productionType, transaction) {
  const prefix = `QC-${productionType}-`;
  await sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:key))", { replacements: { key: `quality-control-reference:${productionType}` }, transaction });
  const [{ n }] = await sequelize.query(
    `SELECT COALESCE(MAX(CAST(substring(reference FROM :start) AS int)), 0)::int AS n
       FROM quality_controls WHERE reference ~ :pattern`,
    { replacements: { start: prefix.length + 1, pattern: `^${prefix}[0-9]+$` }, type: QueryTypes.SELECT, transaction }
  );
  return `${prefix}${String(n + 1).padStart(6, "0")}`;
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

// ── Heure des prélèvements ────────────────────────────────────────────────────

const READING_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const hhmm = (t) => (t == null ? null : String(t).slice(0, 5));
const minutesOf = (t) => {
  const [h, m] = hhmm(t).split(":").map(Number);
  return h * 60 + m;
};
const timeOfMinutes = (min) => {
  const v = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};

// Heure du contrôle au format HH:mm (les secondes éventuelles sont ignorées).
function parseReadingTime(value) {
  const s = String(value ?? "").trim();
  if (!READING_TIME_RE.test(s)) {
    throw { status: 400, code: "INVALID_READING_TIME", message: "Heure du contrôle invalide (HH:mm attendu)" };
  }
  return s.slice(0, 5);
}

// Ordre des ÉTAPES d'une fiche : le rang de création (sequence = dernier rang
// + 1), jamais l'heure — une heure corrigée ne déplace pas une étape.
function sortEntries(control, entries) {
  return [...entries].sort((a, b) => a.row.sequence - b.row.sequence || new Date(a.row.createdAt) - new Date(b.row.createdAt));
}

// Heure PROPOSÉE pour le prochain prélèvement : dernier prélèvement + cadence
// recommandée (3 h) ; premier prélèvement : maintenant (Tunis). Simple suggestion —
// le contrôleur saisit l'heure réelle.
function suggestNextReadingTime(sorted) {
  if (!sorted.length) return tz(clock()).format("HH:mm");
  return timeOfMinutes(minutesOf(sorted[sorted.length - 1].row.readingTime) + cfg.readingIntervalMinutes);
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

// Statut de la FICHE : BROUILLON (validatedAt null — modifiable,
// supprimable, prélèvements ajoutables) ou VALIDÉE (lecture seule). Distinct du
// RÉSULTAT (`status` : À vérifier / CONFORME / NON_CONFORME) — une fiche
// NON CONFORME validée est parfaitement valide. Même règle pour un prélèvement.
function isValidated(row) {
  return row.validatedAt != null;
}

const LOCKED_MESSAGES = Object.freeze({
  update: "Un contrôle validé est en lecture seule et ne peut plus être modifié.",
  delete: "Un contrôle validé ne peut pas être supprimé.",
});
const READING_LOCKED_MESSAGES = Object.freeze({
  update: "Un prélèvement validé est en lecture seule et ne peut plus être modifié.",
  delete: "Un prélèvement validé ne peut pas être supprimé.",
});

// Règles appliquées par l'API (jamais seulement par l'interface).
function assertDraft(control, action) {
  if (isValidated(control)) {
    throw { status: 403, code: "CONTROL_LOCKED", message: LOCKED_MESSAGES[action] };
  }
}

function assertReadingDraft(entry, action) {
  if (isValidated(entry.row)) {
    throw { status: 403, code: "READING_LOCKED", message: READING_LOCKED_MESSAGES[action] };
  }
}

// Paramètres d'un prélèvement dans l'ordre de la configuration : un paramètre
// jamais saisi (ou ajouté à la configuration après la création du prélèvement)
// est présenté « non contrôlé » — aucune ligne vide n'est écrite en base.
// Liste de paramètres d'une fiche : celle de sa machine si elle en a une
// (PROMESH 4), sinon celle de sa ligne.
const lineOf = (c) => cfg.lineKey(c.productionType, c.machine);

function fullItems(items, productionType) {
  const byKey = new Map(items.map((i) => [i.parameterKey, i.toJSON ? i.toJSON() : i]));
  // Contrôles de la LIGNE de la fiche : PROMESH ne porte jamais les
  // contrôles des barres (PROBAR).
  return cfg.readingParametersFor(productionType).map((p) => {
    const i = byKey.get(p.key);
    return {
      id: i?.id ?? null,
      parameterKey: p.key,
      parameterName: p.label,
      position: p.position,
      autoTime: false,
      value: i?.value ?? null,
      status: i?.status ?? ITEM_STATUS.NON_CONTROLE,
      remark: i?.remark ?? null,
      checkedAt: i?.checkedAt ?? null,
      checkedBy: i?.checkedBy ?? null,
      checkedByEmail: i?.checkedByEmail ?? null,
    };
  });
}

// Paramètres PHYSIQUES d'une fiche, dans l'ordre de la configuration de sa
// ligne : un paramètre jamais saisi est présenté vide (aucune ligne vide en
// base). `status` : conservé pour les anciennes fiches (les paramètres
// physiques y portaient un statut) ; la saisie ne porte que la valeur.
// `legacy` : valeurs des anciens contrôles de prélèvement déplacés au niveau de
// la fiche (clé du paramètre → valeur). Reprises tant que la fiche n'a pas
// sa propre valeur ; rien n'est réécrit en base à la lecture.
function ficheItems(params, items, legacy = null) {
  const byKey = new Map(items.map((i) => [i.parameterKey, i.toJSON ? i.toJSON() : i]));
  return params.map((p) => {
    const i = byKey.get(p.key);
    const inherited = i?.value == null ? (legacy?.get(p.key) ?? null) : null;
    return {
      id: i?.id ?? null,
      parameterKey: p.key,
      parameterName: p.label,
      position: p.position,
      section: p.section,
      withStatus: p.withStatus,
      unit: p.unit,
      value: i?.value ?? inherited,
      // Libellé affichable d'un choix (« Bon » pour BON) — sinon la valeur.
      displayValue: p.options.find((o) => o.value === (i?.value ?? inherited))?.label ?? i?.value ?? inherited,
      // true : valeur d'un ancien prélèvement (avant le passage au niveau fiche).
      inherited: inherited != null,
      status: i?.status ?? ITEM_STATUS.NON_CONTROLE,
      remark: i?.remark ?? null,
      checkedAt: i?.checkedAt ?? null,
      checkedByEmail: i?.checkedByEmail ?? null,
    };
  });
}

// Anciennes fiches : valeur du DERNIER prélèvement qui porte l'ancien contrôle.
function legacyFicheValues(params, sortedEntries) {
  const out = new Map();
  for (const p of params) {
    if (!p.legacyKey) continue;
    for (let n = sortedEntries.length - 1; n >= 0; n--) {
      const item = sortedEntries[n].items.find((i) => i.parameterKey === p.legacyKey && i.value != null && String(i.value).trim() !== "");
      if (item) {
        out.set(p.key, item.value);
        break;
      }
    }
  }
  return out;
}

function computeCounts(items) {
  const controlled = items.filter((i) => i.status !== ITEM_STATUS.NON_CONTROLE);
  const nonConformes = items.filter((i) => i.status === ITEM_STATUS.NON_CONFORME);
  return {
    total: items.length,
    controlled: controlled.length,
    conformes: controlled.length - nonConformes.length,
    nonConformes: nonConformes.length,
  };
}

function toReadingResponse(entry, { detail, step, productionType }) {
  const r = entry.row.toJSON ? entry.row.toJSON() : entry.row;
  const items = fullItems(entry.items, productionType);
  return {
    id: r.id,
    // Étape affichée (1, 2, 3… sans trou) et rang stocké (stable).
    step,
    sequence: r.sequence,
    readingTime: hhmm(r.readingTime),
    status: r.status,
    isValidated: isValidated(r),
    validatedAt: r.validatedAt,
    validatedDate: r.validatedAt ? tz(r.validatedAt).format("DD/MM/YYYY") : null,
    validatedTime: r.validatedAt ? tz(r.validatedAt).format("HH:mm:ss") : null,
    counts: computeCounts(items),
    nonConformParameters: items.filter((i) => i.status === ITEM_STATUS.NON_CONFORME).map((i) => i.parameterName),
    ...(detail ? { items } : {}),
  };
}

function toHistoryResponse(h) {
  const r = h.toJSON ? h.toJSON() : h;
  const at = tz(r.changedAt);
  return {
    id: r.id,
    action: r.action,
    readingTime: r.readingTime || null,
    parameterKey: r.parameterKey,
    parameterName: r.parameterKey ? ALL_PARAM_LABELS.get(r.parameterKey) || r.parameterKey : null,
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

// `entries` : prélèvements de la fiche ({ row, items }). `history` fourni =
// réponse DÉTAILLÉE (paramètres de chaque prélèvement + journal).
function toControlResponse(control, entries, { history } = {}) {
  const c = control.toJSON ? control.toJSON() : control;
  const detail = history !== undefined;
  const sorted = sortEntries(c, entries);
  const readings = sorted.map((e, i) => toReadingResponse(e, { detail, step: i + 1, productionType: lineOf(c) }));
  // Niveau fiche : paramètres physiques + contrôle spécifique (treillis GFRP).
  const ficheLevel = entries.physical || [];
  const specific = ficheItems(cfg.specificParameters(lineOf(c)), ficheLevel);
  const last = readings[readings.length - 1] || null;
  const shown = tz(c.checkedAt || c.createdAt);
  const sum = (k) => readings.reduce((s, r) => s + r.counts[k], 0);
  return {
    id: c.id,
    reference: c.reference,
    productionRecordId: c.productionRecordId,
    productionType: c.productionType,
    // Production associée (OPTIONNELLE) — id composite directement
    // utilisable avec GET /production-records/:id ; null sans production.
    productionRecordRef: c.productionRecordId ? `${String(c.productionType).toLowerCase()}:${c.productionRecordId}` : null,
    ficheNumero: c.ficheNumero,
    machine: c.machine,
    machineLabel: machineLabel(c.machine),
    poste: c.poste,
    posteLabel: posteLabel(c.poste),
    productionDate: c.productionDate,
    lot: c.lot ?? null,
    manufacturingOrder: c.manufacturingOrder ?? null,
    // true : valeur reprise de la fiche de production (lecture seule).
    lotAuto: Boolean(c.lotAuto),
    manufacturingOrderAuto: Boolean(c.manufacturingOrderAuto),
    controllerUserId: c.controllerUserId,
    controllerEmail: c.controllerEmail,
    status: c.status,
    remark: c.remark,
    isValidated: isValidated(c),
    checkedAt: c.checkedAt,
    // Date / heure d'OUVERTURE de la fiche (heure de Tunisie) — jamais
    // remplacées par l'heure d'un prélèvement.
    controlDate: c.controlDate ? dayjs(c.controlDate).format("DD/MM/YYYY") : shown.format("DD/MM/YYYY"),
    controlTime: c.controlTime ? String(c.controlTime).slice(0, 8) : shown.format("HH:mm:ss"),
    validatedAt: c.validatedAt,
    // Horodatage serveur de la validation (audit) — distinct de la date /
    // heure d'ouverture, choisies par le contrôleur.
    validatedDate: c.validatedAt ? tz(c.validatedAt).format("DD/MM/YYYY") : null,
    validatedTime: c.validatedAt ? tz(c.validatedAt).format("HH:mm:ss") : null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Prélèvements : une fiche = UN contrôle, quel que soit leur nombre.
    readingsCount: readings.length,
    lastReadingTime: last ? last.readingTime : null,
    suggestedNextReadingTime: suggestNextReadingTime(sorted),
    readings,
    // Paramètres de TOUS les prélèvements de la fiche.
    counts: {
      total: cfg.readingParametersFor(lineOf(c)).length * Math.max(1, readings.length),
      controlled: sum("controlled"),
      conformes: sum("conformes"),
      nonConformes: sum("nonConformes"),
    },
    nonConformParameters: [
      ...new Set([...readings.flatMap((r) => r.nonConformParameters), ...specific.filter((i) => i.status === ITEM_STATUS.NON_CONFORME).map((i) => i.parameterName)]),
    ],
    ...(detail
      ? {
          // Paramètres du DERNIER prélèvement (clients à un seul prélèvement).
          items: last ? last.items : fullItems([], lineOf(c)),
          // PARAMÈTRES PHYSIQUES de la fiche (ceux de sa ligne) — une seule
          // fois, indépendants des prélèvements.
          physicalParameters: ficheItems(cfg.physicalParameters(lineOf(c)), ficheLevel, legacyFicheValues(cfg.physicalParameters(lineOf(c)), sorted)),
          // CONTRÔLE SPÉCIFIQUE de la ligne (PROMESH : treillis GFRP — vide
          // pour PROBAR) : valeur, statut et remarque par paramètre.
          specificParameters: specific,
          // Résultat du contrôle spécifique (PROMESH : dimensionnel et
          // géométrique), calculé sur les paramètres qui portent un statut —
          // jamais sur les caractéristiques descriptives : un non conforme →
          // NON_CONFORME ; sinon au moins un conforme → CONFORME ; rien de
          // renseigné → A_VERIFIER. null quand la ligne n'a pas ce contrôle.
          specificResult: !specific.length
            ? null
            : specific.some((i) => i.status === ITEM_STATUS.NON_CONFORME)
              ? "NON_CONFORME"
              : specific.some((i) => i.status === ITEM_STATUS.CONFORME)
                ? "CONFORME"
                : "A_VERIFIER",
          history: history.map(toHistoryResponse),
        }
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

// Valeur enregistrée d'un contrôle binaire (kind "conformity"), selon son statut.
const CONFORMITY_VALUES = Object.freeze({ CONFORME: "Conforme", NON_CONFORME: "Non conforme" });
const CONFORMITY_STATUS_BY_VALUE = Object.freeze({ Conforme: "CONFORME", "Non conforme": "NON_CONFORME" });

// Applique les modifications demandées aux paramètres d'UN prélèvement (sans les
// enregistrer) et retourne les lignes d'historique correspondantes. Seuls les
// champs réellement présents dans la requête ET différents de la valeur
// actuelle sont touchés — un champ absent n'est jamais remis à zéro, et les
// autres prélèvements de la fiche ne sont jamais concernés.
function applyItemChanges(control, entry, inputs, actor) {
  const byKey = new Map(entry.items.map((i) => [i.parameterKey, i]));
  const history = [];
  const touched = new Set();
  const now = clock();
  const readingTime = hhmm(entry.row.readingTime);

  for (const input of inputs || []) {
    const param = PARAM_BY_KEY.get(input.parameterKey);
    if (!param) {
      throw { status: 400, code: "UNKNOWN_PARAMETER", message: `Paramètre inconnu : ${input.parameterKey}` };
    }
    // PROMESH ≠ PROBAR : un contrôle d'une autre ligne n'est jamais enregistré.
    if (!param.lines.includes(lineOf(control))) {
      throw { status: 400, code: "UNKNOWN_PARAMETER", message: `${param.label} : paramètre non applicable à ${control.productionType}` };
    }
    let item = byKey.get(param.key);
    if (!item) {
      // Créé à la première saisie (jamais de ligne vide en base).
      item = QualityControlItem.build({
        qualityControlId: control.id,
        readingId: entry.row.id,
        parameterKey: param.key,
        parameterName: param.label,
        position: param.position,
        status: ITEM_STATUS.NON_CONTROLE,
      });
    }
    const next = {
      value: normalizeText(input.value),
      status: input.status,
      remark: normalizeText(input.remark),
    };
    // Contrôle binaire (Conforme / Non conforme) : aucune valeur saisie — la
    // valeur enregistrée suit le statut choisi, jamais la valeur reçue.
    if (param.kind === "conformity") {
      if (next.status === undefined && CONFORMITY_STATUS_BY_VALUE[next.value]) next.status = CONFORMITY_STATUS_BY_VALUE[next.value];
      next.value = next.status === undefined || next.status === item.status ? undefined : (CONFORMITY_VALUES[next.status] ?? null);
    }
    for (const field of ["value", "status", "remark"]) {
      if (next[field] === undefined) continue;
      if ((item[field] ?? null) === (next[field] ?? null)) continue;
      history.push(
        historyRow(control, actor, {
          action: "UPDATE",
          readingTime,
          parameterKey: item.parameterKey,
          field,
          oldValue: item[field],
          newValue: next[field],
        })
      );
      item[field] = next[field];
      touched.add(item);
    }
    if (touched.has(item) && !byKey.has(param.key)) {
      byKey.set(param.key, item);
      entry.items.push(item);
    }
  }

  for (const item of touched) {
    item.checkedAt = now;
    item.checkedBy = actor.id;
    item.checkedByEmail = actor.email;
  }
  return { history, touched: [...touched] };
}

// Applique les valeurs demandées aux PARAMÈTRES PHYSIQUES de la fiche
// (niveau fiche : aucun prélèvement concerné, aucun prélèvement modifié). Seuls les
// paramètres de la ligne de la fiche sont acceptés ; un champ absent n'est
// jamais remis à zéro. Retourne l'historique et les lignes à enregistrer.
function applyPhysicalChanges(control, physical, inputs, actor) {
  // Paramètres de niveau fiche de la LIGNE : physiques + contrôle spécifique.
  const allowed = new Map(cfg.ficheParameters(lineOf(control)).map((p) => [p.key, p]));
  const byKey = new Map(physical.map((i) => [i.parameterKey, i]));
  const history = [];
  const touched = new Set();
  for (const input of inputs || []) {
    const param = allowed.get(input.parameterKey);
    if (!param) {
      throw { status: 400, code: "UNKNOWN_PARAMETER", message: `Paramètre inconnu pour ${control.productionType} : ${input.parameterKey}` };
    }
    let item = byKey.get(param.key);
    if (!item) {
      item = QualityControlItem.build({
        qualityControlId: control.id,
        readingId: null,
        parameterKey: param.key,
        parameterName: param.label,
        position: param.position,
        status: ITEM_STATUS.NON_CONTROLE,
      });
    }
    // Paramètre à choix (ex. qualité de coupe : BON | PAS_BON) : seule une
    // valeur de la liste est acceptée ; vide = aucune sélection.
    const chosen = normalizeText(input.value);
    if (param.kind === "choice" && chosen != null && !param.options.some((o) => o.value === chosen)) {
      throw { status: 400, code: "INVALID_VALUE", message: `${param.label} : valeur invalide (${param.options.map((o) => o.value).join(" ou ")} attendu)` };
    }
    // Statut : seulement pour les paramètres qui en portent un (treillis GFRP).
    for (const field of param.withStatus ? ["value", "status", "remark"] : ["value", "remark"]) {
      const next = field === "status" ? input.status : normalizeText(input[field]);
      if (next === undefined || (item[field] ?? null) === (next ?? null)) continue;
      history.push(historyRow(control, actor, { action: "UPDATE", parameterKey: param.key, field, oldValue: item[field], newValue: next }));
      item[field] = next;
      touched.add(item);
    }
    if (touched.has(item) && !byKey.has(param.key)) {
      byKey.set(param.key, item);
      physical.push(item);
    }
  }
  const now = clock();
  for (const item of touched) {
    item.checkedAt = now;
    item.checkedBy = actor.id;
    item.checkedByEmail = actor.email;
  }
  return { history, touched: [...touched] };
}

// ── Champs d'en-tête modifiables (date / heure d'ouverture, date de
// production, poste). Lot et ordre de fabrication : voir
// applyProductionFields (repris de la production, sinon saisis) ──────────

const HEADER_FIELDS = Object.freeze(["controlDate", "controlTime", "productionDate", "poste"]);
// [champ, indicateur « automatique », saisie manuelle possible à défaut].
const PRODUCTION_FIELDS = Object.freeze([
  ["lot", "lotAuto", true],
  ["manufacturingOrder", "manufacturingOrderAuto", false],
]);
const AUTO_REASON = "Récupéré automatiquement de la fiche de production";

// Valeur stockée normalisée pour comparaison (DATEONLY / TIME → texte).
function headerValue(control, field) {
  const v = control[field];
  if (v == null) return null;
  if (field === "controlTime") return String(v).slice(0, 8);
  if (field === "controlDate" || field === "productionDate") {
    return v instanceof Date ? dayjs(v).format("YYYY-MM-DD") : String(v).slice(0, 10);
  }
  return String(v);
}

// Applique les champs d'en-tête PRÉSENTS dans la requête et différents de la
// valeur en base ; retourne les lignes d'historique (ancienne → nouvelle).
// Un champ absent n'est jamais touché (aucune réinitialisation).
function applyHeaderChanges(control, body, actor) {
  const history = [];
  for (const field of HEADER_FIELDS) {
    if (body[field] === undefined) continue;
    const next = body[field] === null ? null : String(body[field]);
    const prev = headerValue(control, field);
    if (prev === next) continue;
    history.push(historyRow(control, actor, { action: "UPDATE", field, oldValue: prev, newValue: next }));
    control[field] = next;
  }
  return history;
}

// Lot et ordre de fabrication de la fiche qualité :
// - ORDRE DE FABRICATION = identification de la fabrication contrôlée
//   (« FAB01 — 28/08/2026 — Ø12 »), TOUJOURS composée par le serveur depuis
//   la fiche de production associée ; jamais saisie : sans production, il
//   est « non renseigné » (NULL) et une valeur envoyée par le client est
//   ignorée ;
// - LOT : repris de la fiche de production quand elle le porte (lecture
//   seule, valeur du client ignorée) ; sinon valeur saisie par le contrôleur
//   (vide = NULL, jamais de valeur fictive). Une ancienne valeur automatique
//   devenue sans source (date ou poste modifié) est effacée, jamais
//   conservée à tort.
function applyProductionFields(control, body, info, actor) {
  const history = [];
  for (const [field, autoFlag, manual] of PRODUCTION_FIELDS) {
    const prev = control[field] ?? null;
    const auto = info?.[field] ?? null;
    let next;
    if (auto != null) next = auto;
    else if (!manual) next = null;
    else if (body[field] !== undefined) next = normalizeText(body[field]);
    else next = control[autoFlag] ? null : prev;
    if (next !== prev) {
      history.push(historyRow(control, actor, { action: "UPDATE", field, oldValue: prev, newValue: next, reason: auto != null ? AUTO_REASON : null }));
      control[field] = next;
    }
    control[autoFlag] = auto != null;
  }
  return history;
}

// ── Association automatique à la fiche de production ─────────────────────

// Recalculée par le SERVEUR (jamais reçue du client) quand la clé de
// recherche — date de production ou poste — vient de changer, ou tant que la
// fiche qualité n'a pas de production (une fiche de production créée après
// coup est rattachée à la sauvegarde suivante). Sans correspondance UNIQUE :
// productionRecordId = NULL, jamais une « mauvaise » production. Une
// association existante dont la clé n'a pas changé est conservée.
async function syncProduction(control, { keyChanged, transaction }) {
  if (!keyChanged && control.productionRecordId) {
    // Association conservée : lot / ordre de fabrication relus (la fiche de
    // production a pu être complétée depuis).
    const info = await readProductionInfo(control.productionType, control.productionRecordId, { transaction });
    return { matched: true, reason: null, info };
  }
  const match = await findProductionForQualityControl(
    {
      productionType: control.productionType,
      machine: control.machine,
      productionDate: headerValue(control, "productionDate"),
      poste: control.poste,
    },
    { transaction }
  );
  control.productionRecordId = match.productionRecordId;
  control.ficheNumero = match.ficheNumero;
  return { matched: match.matched, reason: match.reason, info: { lot: match.lot, manufacturingOrder: match.manufacturingOrder } };
}

// GET /production-match — état de la recherche pour l'écran (message non
// bloquant) + lot / ordre de fabrication de la fiche trouvée : jamais
// l'identité de la fiche de production.
async function productionMatch(query) {
  const { type, machine } = parseMachine(query.productionType, query.machine);
  const match = await findProductionForQualityControl({ productionType: type, machine, productionDate: query.productionDate, poste: query.poste });
  return { matched: match.matched, reason: match.reason, lot: match.lot, manufacturingOrder: match.manufacturingOrder };
}

// UNE fiche ouverte par machine / date de production / poste : les contrôles
// suivants de la journée sont des PRÉLÈVEMENTS de la même fiche, jamais une
// nouvelle fiche. Une fiche déjà VALIDÉE (clôturée) n'empêche pas d'en ouvrir
// une autre. Vérifié à la création et quand la date ou le poste change.
async function assertNoOpenFiche(control, transaction) {
  const date = headerValue(control, "productionDate");
  if (!date || !control.poste) return;
  const other = await QualityControl.findOne({
    where: {
      id: { [Op.ne]: control.id },
      controllerUserId: control.controllerUserId,
      productionType: control.productionType,
      machine: control.machine,
      productionDate: date,
      poste: control.poste,
      validatedAt: null,
    },
    attributes: ["id", "reference"],
    transaction,
  });
  if (!other) return;
  throw {
    status: 409,
    code: "FICHE_EXISTS",
    existingId: other.id,
    message:
      `Une fiche de contrôle qualité est déjà ouverte pour ${control.productionType} · ${machineLabel(control.machine)}, ` +
      `le ${dayjs(date).format("DD/MM/YYYY")}, poste ${posteLabel(control.poste)} (${other.reference}). ` +
      "Ouvrez cette fiche pour y ajouter un prélèvement.",
  };
}

// Anciens contrôles créés avant que la date d'ouverture soit enregistrée :
// à la validation, on fige la valeur AFFICHÉE (création, heure de Tunis).
function fillMissingOpening(control, history, actor) {
  const opened = tz(control.createdAt || clock());
  for (const [field, value] of [
    ["controlDate", opened.format("YYYY-MM-DD")],
    ["controlTime", opened.format("HH:mm:ss")],
  ]) {
    if (control[field] != null) continue;
    history.push(historyRow(control, actor, { action: "UPDATE", field, oldValue: null, newValue: value }));
    control[field] = value;
  }
}

function collectHeaderErrors(control) {
  const errors = [];
  if (headerValue(control, "controlDate") == null) errors.push({ field: "controlDate", parameterKey: null, message: "Date d'ouverture obligatoire" });
  if (headerValue(control, "controlTime") == null) errors.push({ field: "controlTime", parameterKey: null, message: "Heure d'ouverture obligatoire" });
  if (headerValue(control, "productionDate") == null) errors.push({ field: "productionDate", parameterKey: null, message: "Date de production obligatoire" });
  return errors;
}

function hasAnyInput(items) {
  return items.some((i) => PARAM_BY_KEY.has(i.parameterKey) && (i.status !== ITEM_STATUS.NON_CONTROLE || i.value != null || i.remark != null));
}

// Champs obligatoires d'un prélèvement validé — renvoie la liste des erreurs par
// paramètre (vide = OK). Une NON-CONFORMITÉ n'empêche JAMAIS
// l'enregistrement : la remarque explicative est recommandée, pas exigée.
function collectValidationErrors(entry, productionType) {
  const errors = [];
  const readingId = entry.row.id;
  const readingTime = hhmm(entry.row.readingTime);
  const items = fullItems(entry.items, productionType);
  const push = (parameterKey, message) => errors.push({ parameterKey, readingId, readingTime, message });
  if (!items.some((i) => i.status !== ITEM_STATUS.NON_CONTROLE)) {
    push(null, "Au moins un paramètre doit être contrôlé (Conforme ou Non conforme)");
  }
  for (const i of items) {
    if (i.status !== ITEM_STATUS.NON_CONTROLE && i.value == null) {
      push(i.parameterKey, `${i.parameterName} : valeur obligatoire pour un paramètre contrôlé`);
    }
    if (i.status === ITEM_STATUS.NON_CONTROLE && i.value != null) {
      push(i.parameterKey, `${i.parameterName} : indiquer Conforme ou Non conforme pour la valeur saisie`);
    }
  }
  return errors;
}

const isResult = (s) => s === STATUS.CONFORME || s === STATUS.NON_CONFORME;

// Résultat d'un prélèvement validé : un paramètre NON CONFORME force
// NON_CONFORME ; sinon le résultat choisi par le contrôleur (défaut CONFORME).
function resolveReadingStatus(entry, requested, productionType) {
  if (fullItems(entry.items, productionType).some((i) => i.status === ITEM_STATUS.NON_CONFORME)) return STATUS.NON_CONFORME;
  return isResult(requested) ? requested : STATUS.CONFORME;
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

// Prélèvements ({ row, items }) d'un ensemble de fiches, groupés par fiche.
// `full: false` (listes) : seules les colonnes nécessaires aux compteurs.
async function loadEntriesFor(controlIds, { transaction, full = true } = {}) {
  const byControl = new Map(controlIds.map((id) => [id, []]));
  if (!controlIds.length) return byControl;
  const [rows, items] = await Promise.all([
    QualityControlReading.findAll({ where: { qualityControlId: controlIds }, order: [["sequence", "ASC"]], transaction }),
    QualityControlItem.findAll({
      where: { qualityControlId: controlIds },
      ...(full ? {} : { attributes: ["id", "readingId", "parameterKey", "status", "value", "remark"] }),
      transaction,
    }),
  ]);
  const byReading = new Map(rows.map((r) => [r.id, { row: r, items: [] }]));
  // Chaque liste de prélèvements porte aussi `physical` : les paramètres
  // physiques de la fiche (readingId NULL), jamais mêlés à un prélèvement.
  for (const list of byControl.values()) list.physical = [];
  for (const i of items) {
    if (i.readingId == null) byControl.get(i.qualityControlId)?.physical.push(i);
    else byReading.get(i.readingId)?.items.push(i);
  }
  for (const e of byReading.values()) byControl.get(e.row.qualityControlId)?.push(e);
  return byControl;
}

async function loadEntries(controlId, transaction) {
  return (await loadEntriesFor([controlId], { transaction })).get(controlId);
}

async function withItemsForList(controls) {
  if (controls.length === 0) return [];
  const entries = await loadEntriesFor(controls.map((c) => c.id), { full: false });
  return controls.map((c) => toControlResponse(c, entries.get(c.id) || []));
}

function tunisDayStart(dateStr) {
  const d = dayjs.tz(String(dateStr), "YYYY-MM-DD", cfg.timezone);
  if (!d.isValid()) throw { status: 400, code: "INVALID_DATE", message: "Date invalide (AAAA-MM-JJ attendu)" };
  return d;
}

// Filtres de l'Historique → clause WHERE. UNE seule définition, partagée par
// la liste, l'export et la comparaison (mêmes règles, mêmes chiffres).
function buildListWhere(filters, actor) {
  const where = scopeWhere(actor);

  // Un ou plusieurs statuts séparés par des virgules (ex. "À vérifier" =
  // EN_ATTENTE,EN_COURS côté écran Historique).
  if (filters.status) where.status = { [Op.in]: String(filters.status).toUpperCase().split(",").map((s) => s.trim()).filter(Boolean) };
  if (filters.productionType) where.productionType = String(filters.productionType).toUpperCase();
  if (filters.machine) where.machine = String(filters.machine);
  if (filters.poste) where.poste = String(filters.poste);
  // Bornes de dates et période : sur la date EFFECTIVE du contrôle (celle
  // affichée), jamais sur createdAt — mêmes règles que /stats.
  const dateConds = [];
  const effective = sequelize.literal(EFFECTIVE_TS_SQL);
  if (filters.period) {
    const start = periodStart(parsePeriod(filters.period));
    if (start) dateConds.push(sequelize.where(effective, Op.gte, start.format("YYYY-MM-DD")));
  }
  if (filters.from) dateConds.push(sequelize.where(effective, Op.gte, tunisDayStart(filters.from).format("YYYY-MM-DD")));
  if (filters.to) dateConds.push(sequelize.where(effective, Op.lt, tunisDayStart(filters.to).add(1, "day").format("YYYY-MM-DD")));
  if (dateConds.length) where[Op.and] = dateConds;
  // Recherche globale (en-tête / Historique) : référence de fiche, ligne,
  // contrôleur ou machine ("3", "machine 3").
  if (filters.search) {
    const q = String(filters.search).trim().slice(0, 80);
    if (q) {
      const like = `%${q}%`;
      const or = [
        { reference: { [Op.iLike]: like } },
        { lot: { [Op.iLike]: like } },
        { manufacturingOrder: { [Op.iLike]: like } },
        { ficheNumero: { [Op.iLike]: like } },
        { productionType: { [Op.iLike]: like } },
        { controllerEmail: { [Op.iLike]: like } },
      ];
      const m = q.match(/^(?:machine\s*)?(\d+)$/i);
      if (m) or.push({ machine: m[1] });
      where[Op.or] = or;
    }
  }
  return where;
}

async function listControls(filters, actor) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(filters.limit, 10) || 20));
  const where = buildListWhere(filters, actor);

  const { count, rows } = await QualityControl.findAndCountAll({
    where,
    order: EFFECTIVE_ORDER,
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
  const [entries, history] = await Promise.all([
    loadEntries(control.id),
    QualityControlHistory.findAll({ where: { qualityControlId: control.id }, order: [["changedAt", "ASC"], ["id", "ASC"]] }),
  ]);
  return toControlResponse(control, entries, { history });
}

async function listByProductionRecord(ref, productionType, actor) {
  const { type, uuid } = parseProductionRef(ref, productionType);
  const rows = await QualityControl.findAll({
    where: { ...scopeWhere(actor), productionType: type, productionRecordId: uuid },
    order: EFFECTIVE_ORDER,
  });
  return withItemsForList(rows);
}

// ── Statistiques (tableau de bord) ───────────────────────────────────────

const STATS_PERIODS = Object.freeze(["today", "week", "month", "year", "all"]);

// Début de période en heure de Tunisie (semaine = lundi). null = tout.
function periodStart(period) {
  const now = tz(clock());
  switch (period) {
    case "today":
      return now.startOf("day");
    case "week":
      return now.subtract((now.day() + 6) % 7, "day").startOf("day");
    case "month":
      return now.startOf("month");
    case "year":
      return now.startOf("year");
    default:
      return null;
  }
}

// `releves` : nombre de prélèvements — compté À PART : une fiche à 3 prélèvements
// reste UN contrôle.
function emptyCounts() {
  return { total: 0, conforme: 0, nonConforme: 0, aVerifier: 0, releves: 0 };
}

function addCount(target, status, n, releves) {
  target.total += n;
  target.releves += releves;
  if (status === STATUS.CONFORME) target.conforme += n;
  else if (status === STATUS.NON_CONFORME) target.nonConforme += n;
  else target.aVerifier += n;
}

// Agrégats du tableau de bord en DEUX requêtes (GROUP BY + DISTINCT ON) —
// jamais une requête par carte. Même portée que la liste : controle_qualite
// ne compte que ses propres contrôles, les admins tout. Lignes et machines
// = configuration (celles du module Production), aucune inventée.
function parsePeriod(period) {
  const p = period ? String(period).toLowerCase() : "all";
  if (!STATS_PERIODS.includes(p)) {
    throw { status: 400, code: "INVALID_PERIOD", message: `Période invalide (${STATS_PERIODS.join(", ")})` };
  }
  return p;
}

const READINGS_COUNT_SQL = `(SELECT COUNT(*) FROM quality_control_readings r WHERE r."qualityControlId" = quality_controls.id)`;

async function getStats({ period } = {}, actor) {
  const p = parsePeriod(period);
  const start = periodStart(p);
  // Borne = début de période (jour civil de Tunis) comparé à la date
  // EFFECTIVE du contrôle — identique au filtre de GET /quality-control.
  const replacements = { uid: actor.id, from: start ? start.format("YYYY-MM-DD") : null };
  const scopeSql = scopeSqlFor(actor);

  const [grouped, last] = await Promise.all([
    sequelize.query(
      // Fiche BROUILLON = À vérifier ; fiche VALIDÉE = son résultat.
      `SELECT "productionType", machine,
              CASE WHEN "validatedAt" IS NULL THEN 'EN_ATTENTE' ELSE status END AS status,
              COUNT(*)::int AS n,
              COALESCE(SUM(${READINGS_COUNT_SQL}), 0)::int AS releves
         FROM quality_controls
        WHERE "deletedAt" IS NULL ${scopeSql} ${start ? `AND ${EFFECTIVE_TS_SQL} >= CAST(:from AS date)` : ""}
        GROUP BY 1, 2, 3`,
      { replacements, type: QueryTypes.SELECT }
    ),
    // Dernier contrôle de chaque machine, toutes périodes confondues.
    sequelize.query(
      `SELECT DISTINCT ON ("productionType", machine)
              id, reference, "productionType", machine, status, "validatedAt", "ficheNumero", "createdAt", "checkedAt", "controlDate", "controlTime",
              ${READINGS_COUNT_SQL}::int AS releves
         FROM quality_controls
        WHERE "deletedAt" IS NULL ${scopeSql}
        ORDER BY "productionType", machine, ${EFFECTIVE_TS_SQL} DESC, "createdAt" DESC`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  const totals = emptyCounts();
  const lines = cfg.productionLines.map((l) => ({
    type: l.type,
    label: l.label,
    ...emptyCounts(),
    machines: l.machines.map((m) => ({ machine: m, label: machineLabel(m), ...emptyCounts(), lastControl: null })),
  }));
  const lineOf = (type) => lines.find((l) => l.type === String(type).toUpperCase());
  const active = new Set();

  for (const r of grouped) {
    addCount(totals, r.status, r.n, r.releves);
    const line = lineOf(r.productionType);
    if (!line) continue;
    addCount(line, r.status, r.n, r.releves);
    const m = line.machines.find((x) => x.machine === String(r.machine));
    if (m) {
      addCount(m, r.status, r.n, r.releves);
      active.add(`${line.type}:${m.machine}`);
    }
  }
  for (const r of last) {
    const m = lineOf(r.productionType)?.machines.find((x) => x.machine === String(r.machine));
    if (!m) continue;
    // Même date/heure que le contrôle affiché (ouverture choisie par le
    // contrôleur ; à défaut, création en heure de Tunis).
    const at = tz(r.checkedAt || r.createdAt);
    m.lastControl = {
      id: r.id,
      reference: r.reference,
      status: r.status,
      isValidated: r.validatedAt != null,
      ficheNumero: r.ficheNumero,
      releves: r.releves,
      controlDate: r.controlDate ? dayjs(r.controlDate).format("DD/MM/YYYY") : at.format("DD/MM/YYYY"),
      controlTime: r.controlTime ? String(r.controlTime).slice(0, 5) : at.format("HH:mm"),
    };
  }

  return {
    period: p,
    from: start ? start.format("YYYY-MM-DD") : null,
    totals: {
      ...totals,
      machines: lines.reduce((s, l) => s + l.machines.length, 0),
      machinesActives: active.size,
    },
    lines,
  };
}

// ── Écriture : prélèvements ───────────────────────────────────────────────────

// Une même heure n'existe qu'une fois par fiche (index unique en base en
// dernier recours) : l'écran propose d'ouvrir le prélèvement existant ou de
// choisir une autre heure.
async function assertReadingTimeFree(control, time, exceptId, transaction) {
  const existing = await QualityControlReading.findOne({
    where: { qualityControlId: control.id, readingTime: `${time}:00`, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
    attributes: ["id"],
    transaction,
  });
  if (existing) {
    throw { status: 409, code: "READING_TIME_EXISTS", existingReadingId: existing.id, message: `Un prélèvement existe déjà pour ${time}.` };
  }
}

// Nouveau prélèvement (ligne créée, paramètres pas encore saisis) d'une fiche :
// ÉTAPE suivante (dernier rang + 1 — la fiche est verrouillée par la
// transaction, deux créations simultanées ne partagent jamais un rang).
async function newEntry(control, time, entries, actor, history, transaction) {
  await assertReadingTimeFree(control, time, null, transaction);
  const sequence = entries.reduce((max, e) => Math.max(max, e.row.sequence), 0) + 1;
  const row = await QualityControlReading.create(
    { qualityControlId: control.id, sequence, readingTime: `${time}:00`, status: STATUS.EN_ATTENTE },
    { transaction }
  );
  const entry = { row, items: [] };
  entries.push(entry);
  history.push(historyRow(control, actor, { action: "READING_CREATE", readingTime: time, field: "readingTime", newValue: time }));
  return entry;
}

// Sauvegarde d'UN prélèvement dans une transaction : heure, paramètres (valeur /
// statut / remarque) et, si demandé, validation. Les autres prélèvements de la
// fiche ne sont jamais touchés. Retourne true si le prélèvement vient d'être
// validé NON CONFORME (notification).
async function applyReadingSave(control, entry, body, actor, { validate, transaction, history }) {
  assertReadingDraft(entry, "update");
  const { row } = entry;

  if (body.readingTime !== undefined) {
    const next = parseReadingTime(body.readingTime);
    const prev = hhmm(row.readingTime);
    if (next !== prev) {
      await assertReadingTimeFree(control, next, row.id, transaction);
      history.push(historyRow(control, actor, { action: "UPDATE", readingTime: next, field: "readingTime", oldValue: prev, newValue: next }));
      row.readingTime = `${next}:00`;
    }
  }

  const applied = applyItemChanges(control, entry, body.items, actor);
  history.push(...applied.history);

  const previous = row.status;
  let next;
  if (validate) {
    const errors = collectValidationErrors(entry, lineOf(control));
    if (errors.length) throw { status: 422, code: "VALIDATION_FAILED", message: "Champs obligatoires manquants", errors };
    next = resolveReadingStatus(entry, body.status, lineOf(control));
    row.validatedAt = clock();
    history.push(historyRow(control, actor, { action: "READING_VALIDATE", readingTime: hhmm(row.readingTime), field: "status", oldValue: previous, newValue: next }));
  } else {
    next = hasAnyInput(entry.items) ? STATUS.EN_COURS : STATUS.EN_ATTENTE;
  }
  row.status = next;

  for (const item of applied.touched) await item.save({ transaction });
  if (row.changed()) await row.save({ transaction });
  return validate && next === STATUS.NON_CONFORME;
}

// Statut d'une fiche BROUILLON : « en cours » dès qu'un prélèvement porte une
// saisie. Le résultat CONFORME / NON CONFORME n'est posé qu'à la validation
// de la fiche.
function draftStatus(entries) {
  return entries.some((e) => isValidated(e.row) || hasAnyInput(e.items)) ? STATUS.EN_COURS : STATUS.EN_ATTENTE;
}

// ── Écriture : fiche ─────────────────────────────────────────────────────

// Sauvegarde de la FICHE dans une transaction : en-tête, remarque générale,
// association à la production, statut global et — si demandé — validation
// de la fiche (tous ses prélèvements brouillons sont validés avec elle). Toute
// erreur annule l'ensemble. Le résultat CONFORME comme NON_CONFORME est
// enregistré : seules les données obligatoires peuvent refuser une
// validation.
async function applySave(control, entries, body, actor, { validate, transaction, history, isNew = false }) {
  const headerHistory = applyHeaderChanges(control, body, actor);
  history.push(...headerHistory);
  const keyChanged = isNew || headerHistory.some((h) => h.field === "productionDate" || h.field === "poste");
  if (keyChanged) await assertNoOpenFiche(control, transaction);
  const production = await syncProduction(control, { keyChanged, transaction });
  history.push(...applyProductionFields(control, body, production.info, actor));

  // Paramètres physiques : niveau fiche, enregistrés avec elle.
  if (!entries.physical) entries.physical = [];
  const physical = applyPhysicalChanges(control, entries.physical, [...(body.physical || []), ...(body.specific || [])], actor);
  history.push(...physical.history);
  for (const item of physical.touched) await item.save({ transaction });

  const nextRemark = normalizeText(body.remark);
  if (nextRemark !== undefined && (control.remark ?? null) !== (nextRemark ?? null)) {
    history.push(historyRow(control, actor, { action: "UPDATE", field: "remark", oldValue: control.remark, newValue: nextRemark }));
    control.remark = nextRemark;
  }

  const previousStatus = control.status;
  let nextStatus;

  if (validate) {
    fillMissingOpening(control, history, actor);
    const errors = collectHeaderErrors(control);
    if (entries.length === 0) errors.push({ parameterKey: null, message: "Au moins un prélèvement de contrôle est obligatoire" });
    const drafts = sortEntries(control, entries).filter((e) => !isValidated(e.row));
    for (const entry of drafts) {
      const time = hhmm(entry.row.readingTime);
      errors.push(...collectValidationErrors(entry, lineOf(control)).map((e) => ({ ...e, message: entries.length > 1 ? `Prélèvement ${time} — ${e.message}` : e.message })));
    }
    if (errors.length) {
      throw { status: 422, code: "VALIDATION_FAILED", message: "Champs obligatoires manquants", errors };
    }
    for (const entry of drafts) {
      await applyReadingSave(control, entry, {}, actor, { validate: true, transaction, history });
    }
    // Un prélèvement NON CONFORME force le résultat de la fiche ; sinon le
    // résultat choisi par le contrôleur (défaut CONFORME).
    // … de même qu'un contrôle spécifique (treillis GFRP) non conforme.
    const specificKeys = new Set(cfg.specificParameters(lineOf(control)).map((p) => p.key));
    const specificNc = entries.physical.some((i) => specificKeys.has(i.parameterKey) && i.status === ITEM_STATUS.NON_CONFORME);
    nextStatus = specificNc || entries.some((e) => e.row.status === STATUS.NON_CONFORME)
      ? STATUS.NON_CONFORME
      : isResult(body.status)
        ? body.status
        : STATUS.CONFORME;
  } else {
    nextStatus = draftStatus(entries);
  }

  if (nextStatus !== previousStatus) {
    history.push(historyRow(control, actor, { action: "STATUS_CHANGE", field: "status", oldValue: previousStatus, newValue: nextStatus }));
    control.status = nextStatus;
  }

  if (validate) {
    // Horodatage serveur de la validation (audit) + contrôleur. La date /
    // heure d'ouverture choisies par le contrôleur ne sont JAMAIS écrasées.
    const now = clock();
    control.checkedAt = now;
    control.validatedAt = now;
    history.push(historyRow(control, actor, { action: "VALIDATE", field: "status", newValue: nextStatus }));
  }

  if (control.changed()) await control.save({ transaction });
  if (history.length) await QualityControlHistory.bulkCreate(history, { transaction });

  return { production, notifyNc: validate && nextStatus === STATUS.NON_CONFORME };
}

// Prélèvement visé par une saisie envoyée SANS identifiant de prélèvement (corps
// `items` sur POST / PUT / validate de la fiche) : le dernier prélèvement
// brouillon ; à défaut de tout prélèvement, un premier prélèvement est créé à l'heure
// indiquée (`readingTime`) ou à l'heure d'ouverture de la fiche.
async function implicitEntry(control, entries, body, actor, history, transaction) {
  const drafts = sortEntries(control, entries).filter((e) => !isValidated(e.row));
  if (drafts.length) return drafts[drafts.length - 1];
  if (entries.length) {
    throw { status: 403, code: "READING_LOCKED", message: "Tous les prélèvements de cette fiche sont validés : créez un nouveau prélèvement." };
  }
  const time = body.readingTime != null ? parseReadingTime(body.readingTime) : hhmm(headerValue(control, "controlTime")) || tz(clock()).format("HH:mm");
  return newEntry(control, time, entries, actor, history, transaction);
}

// État de l'association renvoyé après une sauvegarde (message non bloquant
// de l'écran).
function matchState(production) {
  return { matched: production.matched, reason: production.reason };
}

async function respond(controlId, actor, { production, notify, readingId } = {}) {
  const response = await getControlById(controlId, actor);
  if (production !== undefined) response.productionMatch = matchState(production);
  if (readingId) response.readingId = readingId;
  if (notify) response.notificationsSent = await notifyNonConformity(response, actor, notify);
  return response;
}

// CRÉATION (POST) — fiche qualité d'une MACHINE : productionType + machine
// (ceux de la page machine, vérifiés contre la configuration). Le corps peut
// porter l'en-tête, la remarque et le PREMIER prélèvement (`reading` : heure,
// paramètres, validation du prélèvement) ; `validate: true` + `status` valident
// la FICHE dans la même transaction. En cas d'erreur, rien n'est créé.
async function createControl(body, actor) {
  const { type, machine } = parseMachine(body.productionType, body.machine);
  let saved;
  let readingNc = null;
  let readingId = null;

  const result = await sequelize.transaction(async (transaction) => {
    const opened = tz(clock());
    const control = await QualityControl.create(
      {
        reference: await nextReference(type, transaction),
        productionType: type,
        machine,
        // Valeurs PROPOSÉES à la création, modifiables ensuite (brouillon).
        productionDate: opened.format("YYYY-MM-DD"),
        controlDate: opened.format("YYYY-MM-DD"),
        controlTime: opened.format("HH:mm:ss"),
        poste: null,
        // Auteur = utilisateur AUTHENTIFIÉ (JWT), jamais le corps.
        controllerUserId: actor.id,
        controllerEmail: actor.email,
        status: STATUS.EN_ATTENTE,
        remark: null,
      },
      { transaction }
    );
    const history = [historyRow(control, actor, { action: "CREATE", field: "status", newValue: STATUS.EN_ATTENTE })];
    const entries = [];
    // En-tête d'abord : l'heure d'ouverture saisie sert d'heure par défaut
    // au premier prélèvement.
    history.push(...applyHeaderChanges(control, body, actor));

    const reading = body.reading || (body.items !== undefined || body.readingTime !== undefined ? { readingTime: body.readingTime, items: body.items } : null);
    if (reading) {
      const entry = await implicitEntry(control, entries, { readingTime: reading.readingTime }, actor, history, transaction);
      readingId = entry.row.id;
      if (await applyReadingSave(control, entry, { items: reading.items, status: reading.status }, actor, { validate: reading.validate === true, transaction, history })) {
        readingNc = hhmm(entry.row.readingTime);
      }
    }

    saved = await applySave(control, entries, body, actor, { validate: body.validate === true, transaction, history, isNew: true });
    return control;
  });

  return respond(result.id, actor, {
    production: saved.production,
    readingId,
    notify: saved.notifyNc ? { scope: "fiche" } : readingNc ? { scope: "reading", readingTime: readingNc } : null,
  });
}

// Partagé par PUT (update) et POST /validate de la FICHE.
async function saveControl(id, body, actor, { validate }) {
  let saved;

  const controlId = await sequelize.transaction(async (transaction) => {
    const control = await loadControlForActor(id, actor, { transaction, lock: true });
    // VALIDÉE = lecture seule : ni modification, ni nouvelle validation.
    assertDraft(control, "update");
    const entries = await loadEntries(control.id, transaction);
    const history = [];
    if (body.items && body.items.length) {
      const entry = await implicitEntry(control, entries, {}, actor, history, transaction);
      await applyReadingSave(control, entry, { items: body.items }, actor, { validate: false, transaction, history });
    }
    saved = await applySave(control, entries, body, actor, { validate, transaction, history });
    return control.id;
  });

  return respond(controlId, actor, { production: saved.production, notify: saved.notifyNc ? { scope: "fiche" } : null });
}

function updateControl(id, body, actor) {
  return saveControl(id, body, actor, { validate: false });
}

function validateControl(id, body, actor) {
  return saveControl(id, body, actor, { validate: true });
}

// ── Prélèvements d'une fiche (POST / PUT / validate / DELETE) ─────────────────

// Opération sur les prélèvements d'une fiche BROUILLON, dans une transaction ;
// le statut « en cours » de la fiche est tenu à jour.
async function withReadings(controlId, actor, fn) {
  let out;
  await sequelize.transaction(async (transaction) => {
    const control = await loadControlForActor(controlId, actor, { transaction, lock: true });
    assertDraft(control, "update");
    const entries = await loadEntries(control.id, transaction);
    const history = [];
    out = await fn({ control, entries, history, transaction });
    const status = draftStatus(entries);
    if (status !== control.status) {
      history.push(historyRow(control, actor, { action: "STATUS_CHANGE", field: "status", oldValue: control.status, newValue: status }));
      control.status = status;
      await control.save({ transaction });
    }
    if (history.length) await QualityControlHistory.bulkCreate(history, { transaction });
  });
  return out;
}

function findEntry(entries, readingId) {
  const entry = UUID_RE.test(String(readingId || "")) ? entries.find((e) => e.row.id === readingId) : null;
  if (!entry) throw { status: 404, code: "READING_NOT_FOUND", message: "Prélèvement introuvable" };
  return entry;
}

// NOUVEAU PRÉLÈVEMENT : une nouvelle ligne à l'heure saisie — jamais une
// modification d'un prélèvement existant. `validate: true` le valide aussitôt.
async function createReading(controlId, body, actor) {
  const time = parseReadingTime(body.readingTime);
  const out = await withReadings(controlId, actor, async ({ control, entries, history, transaction }) => {
    const entry = await newEntry(control, time, entries, actor, history, transaction);
    const nc = await applyReadingSave(control, entry, { items: body.items, status: body.status }, actor, { validate: body.validate === true, transaction, history });
    return { readingId: entry.row.id, nc };
  });
  return respond(controlId, actor, { readingId: out.readingId, notify: out.nc ? { scope: "reading", readingTime: time } : null });
}

async function saveReading(controlId, readingId, body, actor, { validate }) {
  const out = await withReadings(controlId, actor, async ({ control, entries, history, transaction }) => {
    const entry = findEntry(entries, readingId);
    const nc = await applyReadingSave(control, entry, body, actor, { validate, transaction, history });
    return { nc, time: hhmm(entry.row.readingTime) };
  });
  return respond(controlId, actor, { readingId, notify: out.nc ? { scope: "reading", readingTime: out.time } : null });
}

function updateReading(controlId, readingId, body, actor) {
  return saveReading(controlId, readingId, body, actor, { validate: false });
}

function validateReading(controlId, readingId, body, actor) {
  return saveReading(controlId, readingId, body, actor, { validate: true });
}

// Suppression d'un prélèvement BROUILLON (fiche brouillon) : ses paramètres sont
// supprimés avec lui, l'action reste au journal. Les autres prélèvements sont
// intacts.
async function deleteReading(controlId, readingId, actor) {
  await withReadings(controlId, actor, async ({ control, entries, history, transaction }) => {
    const entry = findEntry(entries, readingId);
    assertReadingDraft(entry, "delete");
    history.push(historyRow(control, actor, { action: "READING_DELETE", readingTime: hhmm(entry.row.readingTime), field: "status", oldValue: entry.row.status }));
    await QualityControlItem.destroy({ where: { readingId: entry.row.id }, transaction });
    await entry.row.destroy({ transaction });
    entries.splice(entries.indexOf(entry), 1);
  });
  return respond(controlId, actor);
}

// Suppression d'une fiche BROUILLON uniquement — LOGIQUE (paranoid) : la
// fiche, ses prélèvements, leurs paramètres et l'historique restent en base
// (audit) mais disparaissent de toutes les listes / statistiques. Action
// journalisée.
async function deleteControl(id, actor) {
  await sequelize.transaction(async (transaction) => {
    const control = await loadControlForActor(id, actor, { transaction, lock: true });
    assertDraft(control, "delete");
    await QualityControlHistory.create(historyRow(control, actor, { action: "DELETE", field: "status", oldValue: control.status }), { transaction });
    control.deletedBy = actor.id;
    await control.save({ transaction });
    await control.destroy({ transaction });
  });
  return { id };
}

// ── Notifications internes ───────────────────────────────────────────────

function buildNonConformityMessage(control, { scope, readingTime }) {
  const reading = scope === "reading" ? control.readings.find((r) => r.readingTime === readingTime) : null;
  const names = reading ? reading.nonConformParameters : control.nonConformParameters;
  const params = names.length ? names.join(", ") : "aucun (non-conformité globale)";
  return [
    `Fiche qualité : ${control.reference}`,
    ...(reading ? [`Prélèvement : ${readingTime}`] : []),
    `Production : ${control.productionType}`,
    `Machine : ${control.machineLabel || "—"}`,
    `Fiche de production : ${control.ficheNumero || "aucune"}`,
    `Date : ${control.controlDate} ${control.controlTime}`,
    `Contrôleur : ${control.controllerEmail}`,
    `Paramètre(s) non conforme(s) : ${params}`,
  ].join(" · ");
}

// Notification interne (table notifications + socket) aux responsables
// Production — jamais d'email, jamais le client. Envoyée quand un prélèvement est
// validé NON CONFORME et quand la fiche est validée NON CONFORME. Un échec
// n'annule jamais le contrôle déjà enregistré : il est seulement journalisé.
async function notifyNonConformity(control, actor, scope) {
  try {
    const recipients = await User.findAll({
      where: { email: cfg.notifyRecipients, isActive: true },
      attributes: ["id", "email"],
    });
    const message = buildNonConformityMessage(control, scope).slice(0, 500);
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
        readingTime: scope.readingTime || null,
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

// Paramètres AFFICHABLES : ceux d'au moins une ligne. Un paramètre retiré de
// toutes les lignes (`lines` vide) n'est plus renvoyé à l'interface.
function listParameters() {
  return cfg.parameters.filter((p) => p.lines.length > 0).map((p) => ({
    key: p.key,
    label: p.label,
    position: p.position,
    autoTime: p.autoTime,
    // "reading" : contrôle d'un prélèvement ; "fiche" : paramètre physique de la
    // fiche, pour les lignes `lines`.
    scope: p.scope,
    lines: p.lines,
    // Présentation propre à une ligne (PROMESH : catégorie, ordre, libellé).
    byLine: p.byLine,
    withStatus: p.withStatus,
    section: p.section,
    // Sous-groupe d'affichage (ex. « Viscosité de la résine » : bain 1 / bain 2).
    group: p.group,
    shortLabel: p.shortLabel,
    kind: p.kind,
    unit: p.unit,
    hint: p.hint,
    options: p.options,
  }));
}

// Configuration complète du module (catégories du prélèvement, paramètres, lignes
// de production et leurs machines) — Flutter ne code rien de tout cela en dur.
function getConfig() {
  return {
    parameters: listParameters(),
    // Seulement les sections qui ont encore un paramètre affichable
    // (retirées : Barre, Assemblage et Mécanique du treillis).
    sections: cfg.sections.filter((s) =>
      cfg.parameters.some((p) => (p.section === s.key && p.lines.some((l) => !p.byLine[l])) || Object.entries(p.byLine).some(([l, v]) => p.lines.includes(l) && v.section === s.key))
    ),
    productionLines: cfg.productionLines,
    // Machines qui ont leur propre liste de paramètres (clé dans `lines` / `byLine`).
    machineLines: cfg.machineLines,
    readingIntervalMinutes: cfg.readingIntervalMinutes,
    statuses: Object.values(STATUS),
    itemStatuses: Object.values(ITEM_STATUS),
  };
}

module.exports = {
  STATUS,
  ITEM_STATUS,
  // Partagés avec qualityControlReports.service (export / comparaison).
  buildListWhere,
  EFFECTIVE_ORDER,
  // Partagés avec qualityControlComparison.service (agrégations SQL).
  EFFECTIVE_TS_SQL,
  scopeSqlFor,
  loadEntriesFor,
  toControlResponse,
  isValidated,
  tunisDayStart,
  listParameters,
  getConfig,
  listControls,
  getStats,
  getControlById,
  listByProductionRecord,
  productionMatch,
  createControl,
  updateControl,
  validateControl,
  deleteControl,
  createReading,
  updateReading,
  validateReading,
  deleteReading,
  setClock,
};
