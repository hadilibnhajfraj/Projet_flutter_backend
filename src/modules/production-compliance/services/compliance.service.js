"use strict";

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { QueryTypes, Op } = require("sequelize");

dayjs.extend(utc);
dayjs.extend(timezone);

const { sequelize } = require("../../../db");
const cfg = require("../../../config/productionCompliance");
const User = require("../../../models/User");
const Notification = require("../../../models/Notification");
const Authorization = require("../../../models/ProductionComplianceAuthorization");
const Alert = require("../../../models/ProductionComplianceAlert");
const AuthRequest = require("../../../models/ProductionComplianceAuthorizationRequest");
const mail = require("./mail");
const logger = require("../../../utils/logger");

const BACKFILL = "BACKFILL_PREVIOUS_PRODUCTION";
const BYPASS = "BYPASS_MISSING_PRODUCTION_DATE";

class ComplianceError extends Error {
  constructor(status, code, message, messageFr, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.messageFr = messageFr;
    this.extra = extra;
  }
  toJSON() {
    return { success: false, code: this.code, message: this.message, messageFr: this.messageFr, ...this.extra };
  }
}

// ── Heure de Tunisie ─────────────────────────────────────────────────────

let clock = () => new Date();
const setClock = (fn) => { clock = fn || (() => new Date()); };

const tz = cfg.timezone;
const tzNow = (now = clock()) => dayjs(now).tz(tz);
const todayStr = (now) => tzNow(now).format("YYYY-MM-DD");
const shiftDate = (d, n) => dayjs.utc(d).add(n, "day").format("YYYY-MM-DD");
const isoDow = (d) => {
  const w = dayjs.utc(d).day();
  return w === 0 ? 7 : w;
};
const isWorkingDay = (d) => cfg.workingDays.includes(isoDow(d)) && !cfg.nonWorkingDates.includes(d);
const dateInTz = (date) => dayjs(date).tz(tz).format("YYYY-MM-DD");
const frDate = (d) => String(d).split("-").reverse().join("/");

function windowFor(prod, dateStr) {
  return {
    start: dayjs.tz(`${dateStr} ${prod.start}`, tz).toDate(),
    end: dayjs.tz(`${dateStr} ${prod.end}`, tz).toDate(),
  };
}

// Date de production reçue d'un client → "YYYY-MM-DD" (jour de Tunis).
function normalizeDate(input) {
  if (input == null || input === "") return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    const midnightUtc = input.getUTCHours() === 0 && input.getUTCMinutes() === 0 && input.getUTCSeconds() === 0;
    return midnightUtc ? input.toISOString().slice(0, 10) : dateInTz(input);
  }
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = dayjs(s);
  return d.isValid() ? dateInTz(d.toDate()) : null;
}

function getMonitoredByEmail(email) {
  if (!email) return null;
  const e = String(email).trim().toLowerCase();
  return Object.values(cfg.productions).find((p) => p.email === e) || null;
}

const isManagerEmail = (email) => !!email && cfg.managers.includes(String(email).trim().toLowerCase());

// Rôles Super Admin — MÊME liste que côté Flutter (auth_service.dart isAdmin) et
// que le pattern déjà utilisé pour la maintenance (requireMaintenanceManager.js,
// MAINTENANCE_MANAGER_ROLES) : réutilisation du système de permissions existant,
// pas un nouveau. Volontairement SANS "responsable_logistique_achat" : c'est le
// rôle de production_1/production_2 eux-mêmes (§16 : ne jamais leur donner accès
// à la gestion des demandes, seulement à cfg.managers qui reste la seule liste
// email-explicite pour eux).
const SUPER_ADMIN_ROLES = ["admin", "superadmin", "superadmin2"];
const isSuperAdminRole = (role) => SUPER_ADMIN_ROLES.includes(String(role || "").trim().toLowerCase());

// Accès à la gestion des demandes (voir/approuver/refuser) : responsable
// explicitement configuré (cfg.managers, par email) OU Super Admin (par rôle
// réel en base) — jamais l'un sans revérifier l'autre depuis la base, jamais
// seulement le JWT. Un compte Super Admin garde donc l'accès même si son e-mail
// n'a pas (ou plus) été ajouté à PRODUCTION_COMPLIANCE_MANAGERS.
const isComplianceManagerUser = (user) => !!user && (isManagerEmail(user.email) || isSuperAdminRole(user.role));

async function findUserByEmail(email, transaction) {
  return User.findOne({ where: { email }, attributes: ["id", "email", "role", "isActive"], transaction });
}

// ── Lecture des fiches réellement créées ─────────────────────────────────
// Sources (colonnes réelles) : por_promesh (dateProduction, createdBy,
// status) et industrial_records module 'probar' (dateFiche, createdBy,
// statut). Une fiche compte pour un jour D si sa DATE DE PRODUCTION vaut D
// et si elle a été créée par l'utilisateur ; sa date de création (createdAt)
// détermine si elle a été saisie dans la plage obligatoire.

async function sheetsInRange(userId, from, to, transaction) {
  const dP = cfg.countDrafts ? "" : " AND pp.status <> 'BROUILLON'";
  const dI = cfg.countDrafts ? "" : " AND LOWER(ir.statut) <> 'brouillon'";
  return sequelize.query(
    `SELECT 'PROMESH' AS type, pp.id::text AS id, pp."dateProduction"::text AS date, pp.status::text AS status, pp."createdAt" AS "createdAt"
       FROM por_promesh pp
      WHERE pp."createdBy" = :userId AND pp."dateProduction" BETWEEN :from AND :to ${dP}
     UNION ALL
     SELECT 'PROBAR', ir.id::text, ir."dateFiche"::text, ir.statut::text, ir."createdAt"
       FROM industrial_records ir
      WHERE ir."createdBy" = :userId AND ir.module = 'probar' AND ir."dateFiche" BETWEEN :from AND :to ${dI}
     ORDER BY 3, 5`,
    { replacements: { userId, from, to }, type: QueryTypes.SELECT, transaction }
  );
}

// ── Évaluation jour par jour ─────────────────────────────────────────────

const isActiveBackfill = (a, now) => a.type === BACKFILL && !a.revokedAt && !a.usedAt && (!a.expiresAt || new Date(a.expiresAt) > now);

function authView(a, now) {
  return {
    id: a.id,
    type: a.type,
    date: a.productionDate,
    authorizedBy: a.authorizedByEmail,
    authorizedById: a.authorizedBy,
    authorizedAt: a.authorizedAt,
    expiresAt: a.expiresAt,
    reason: a.reason,
    revokedAt: a.revokedAt,
    usedAt: a.usedAt,
    usedFicheType: a.usedFicheType,
    usedFicheId: a.usedFicheId,
    active: a.type === BACKFILL ? isActiveBackfill(a, now) : !a.revokedAt,
  };
}

/**
 * États quotidiens d'une production pour un utilisateur, dans [from, to]
 * (bornés par startDate et par aujourd'hui de Tunis), jours travaillés
 * uniquement. Tri croissant par date.
 */
async function computeDays(prod, userId, from, to, { now = clock(), transaction } = {}) {
  const today = todayStr(now);
  const last = to > today ? today : to;
  const first = from < cfg.startDate ? cfg.startDate : from;
  if (first > last) return [];

  const load = [
    () => sheetsInRange(userId, first, last, transaction),
    () => Authorization.findAll({ where: { userId, productionType: prod.key }, order: [["authorizedAt", "DESC"]], transaction }),
    () => Alert.findAll({ where: { userId, productionType: prod.key }, transaction }),
    // Demandes ACTIVES (PENDING/APPROVED) — pour ne jamais proposer "Authorize
    // backfill" (§13) ni laisser créer une 2e demande (voir requests.service) sur
    // une date déjà couverte par une demande existante.
    () => AuthRequest.findAll({ where: { userId, productionType: prod.key, status: { [Op.in]: ["PENDING", "APPROVED"] } }, transaction }),
  ];
  // Une transaction n'accepte qu'une requête à la fois ; sans transaction on parallélise.
  let sheets, auths, alerts, activeRequests;
  if (transaction) {
    sheets = await load[0]();
    auths = await load[1]();
    alerts = await load[2]();
    activeRequests = await load[3]();
  } else {
    [sheets, auths, alerts, activeRequests] = await Promise.all(load.map((f) => f()));
  }

  const rows = [];
  let guard = 0;
  for (let d = first; d <= last && guard < 800; d = shiftDate(d, 1), guard += 1) {
    if (!isWorkingDay(d)) continue;
    const win = windowFor(prod, d);
    const ds = sheets.filter((s) => s.date === d);
    const inWindow = ds.filter((s) => new Date(s.createdAt) >= win.start && new Date(s.createdAt) <= win.end);
    const dayAuths = auths.filter((a) => a.productionDate === d);
    const bypass = dayAuths.find((a) => a.type === BYPASS && !a.revokedAt);
    const usedBackfill = dayAuths.find((a) => a.type === BACKFILL && a.usedAt);
    const activeBackfill = dayAuths.find((a) => isActiveBackfill(a, now));

    let status;
    if (ds.length) {
      // RÈGLE (correction) : une fiche existe ne suffit PAS — seule une fiche saisie
      // DANS la plage horaire de la production compte comme "completed". Une ou
      // plusieurs fiches existantes hors plage (même saisies le jour même) ne
      // régularisent PAS la journée d'elles-mêmes : elle reste "manquante" (exige une
      // autorisation), exactement comme si aucune fiche n'existait — sauf si elle a
      // été explicitement régularisée via une autorisation BACKFILL consommée
      // (usedBackfill) ou clairement saisie après coup (createdAt > d). Les fiches
      // existantes ne sont ni supprimées ni modifiées, seul le STATUT affiché change.
      if (inWindow.length) status = "completed";
      else if (usedBackfill || ds.some((s) => dateInTz(s.createdAt) > d)) status = "backfilled";
      else if (d === today) status = now < win.end ? "pending" : "missing";
      else status = activeBackfill ? "backfill_authorized" : "awaiting_authorization";
    } else if (bypass) {
      status = "authorized_bypass";
    } else if (d === today) {
      status = now < win.end ? "pending" : "missing";
    } else {
      status = activeBackfill ? "backfill_authorized" : "awaiting_authorization";
    }

    // Demande couvrant CE jour (§13) : une demande PENDING le couvre toujours ; une
    // demande APPROVED ne le couvre plus une fois son autorisation consommée
    // (usedBackfill déjà vrai dans ce cas) — jamais les deux à la fois pour la même
    // date (une seule demande active par utilisateur/production, voir requests.service).
    const coveringRequest = activeRequests.find((r) => {
      const rDates = Array.isArray(r.missingDates) && r.missingDates.length ? r.missingDates : [r.missingDate];
      if (!rDates.includes(d)) return false;
      return r.status === "PENDING" || !usedBackfill;
    });

    const alert = alerts.find((a) => a.productionDate === d);
    rows.push({
      date: d,
      productionKey: prod.key,
      production: prod.label,
      userId,
      userEmail: prod.email,
      periodStart: prod.start,
      periodEnd: prod.end,
      sheetsCount: ds.length,
      sheetsInWindow: inWindow.length,
      sheets: ds.map((s) => ({ type: s.type, id: s.id, status: s.status, createdAt: s.createdAt })),
      status,
      alert: alert
        // id exposé — nécessaire au bouton "Retry email" (Super Admin, §10 du
        // ticket SMTP) : POST /production-compliance/alerts/:id/retry-email.
        ? { id: alert.id, status: alert.status, emailSentAt: alert.emailSentAt, recipients: alert.recipients, attempts: alert.attempts, lastError: alert.lastError }
        : null,
      authorization: dayAuths[0] ? authView(dayAuths[0], now) : null,
      authorizations: dayAuths.map((a) => authView(a, now)),
      // Demande déjà existante couvrant ce jour, le cas échéant (§13/§14) : le
      // frontend affiche "Request pending"/"Authorization granted" au lieu d'un
      // second bouton quand ce champ est renseigné.
      coveringRequestId: coveringRequest?.id || null,
      coveringRequestStatus: coveringRequest?.status || null,
      // Bouton "Authorize backfill" (Super Admin) : uniquement quand le jour exige
      // effectivement une autorisation ET qu'AUCUNE demande ne le couvre déjà
      // (§13 : jamais un 2e bouton/une 2e voie d'autorisation sur une date déjà
      // prise en charge par une demande PENDING ou APPROVED).
      canAuthorize: d < today && status === "awaiting_authorization" && !bypass && !coveringRequest,
    });
  }
  return rows;
}

const BLOCKING = new Set(["awaiting_authorization", "backfill_authorized"]);

/** Toutes les dates travaillées passées, non régularisées (ni fiche, ni passage autorisé), triées croissant. */
async function blockingDays(prod, userId, { now = clock(), transaction } = {}) {
  const today = todayStr(now);
  const rows = await computeDays(prod, userId, cfg.startDate, shiftDate(today, -1), { now, transaction });
  return rows.filter((r) => BLOCKING.has(r.status));
}

async function blockingDates(prod, userId, opts = {}) {
  return (await blockingDays(prod, userId, opts)).map((r) => r.date);
}

/** Plus ancienne date passée non régularisée (ni fiche, ni passage autorisé). */
async function firstBlockingDate(prod, userId, { now = clock(), transaction } = {}) {
  const days = await blockingDays(prod, userId, { now, transaction });
  return days[0] || null;
}

/**
 * Dernière date de production RÉELLEMENT enregistrée pour cet utilisateur
 * (toutes dates confondues, sans borne — respecte PRODUCTION_COMPLIANCE_COUNT_DRAFTS
 * via sheetsInRange), à titre purement informatif/diagnostic. N'est PAS utilisée
 * comme borne de calcul : computeDays() évalue déjà CHAQUE jour individuellement
 * entre cfg.startDate et hier, donc un jour manquant est détecté qu'il soit avant
 * OU après cette date (une simple avance du point de départ jusqu'à ce jour
 * masquerait un manque plus ancien resté vraiment non régularisé).
 */
async function lastKnownProductionDate(userId, transaction) {
  const [row] = await sequelize.query(
    `SELECT MAX(d)::text AS d FROM (
       SELECT pp."dateProduction" AS d FROM por_promesh pp WHERE pp."createdBy" = :userId${cfg.countDrafts ? "" : " AND pp.status <> 'BROUILLON'"}
       UNION ALL
       SELECT ir."dateFiche" FROM industrial_records ir WHERE ir."createdBy" = :userId AND ir.module = 'probar'${cfg.countDrafts ? "" : " AND LOWER(ir.statut) <> 'brouillon'"}
     ) s`,
    { replacements: { userId }, type: QueryTypes.SELECT, transaction }
  );
  return row?.d || null;
}

/**
 * FONCTION CENTRALE unique de calcul des dates de production manquantes —
 * réutilisée par TOUT le module (assertCanCreate, createRequest, dashboard,
 * summary, Super Admin, alertes ne testent qu'un seul jour via sheetsInRange
 * mais partagent la même source) : jamais deux algorithmes différents.
 * Portée : [cfg.startDate, hier], jours travaillés uniquement (aucune fenêtre
 * fixe de type "5/7/10 derniers jours") — un jour n'est "manquant" que s'il n'a
 * AUCUNE fiche valide ET aucun passage autorisé (BYPASS) actif.
 */
async function getMissingProductionDates({ userId, email, now = clock(), transaction } = {}) {
  const prod = getMonitoredByEmail(email);
  if (!prod) return { production: null, user: email || null, lastKnownDate: null, today: todayStr(now), missingDates: [] };
  // Séquentiel si transaction (un client pg ne traite qu'une requête à la fois,
  // voir computeDays()) ; parallèle sinon.
  let missingDates, lastKnownDate;
  if (transaction) {
    missingDates = await blockingDates(prod, userId, { now, transaction });
    lastKnownDate = await lastKnownProductionDate(userId, transaction);
  } else {
    [missingDates, lastKnownDate] = await Promise.all([blockingDates(prod, userId, { now }), lastKnownProductionDate(userId)]);
  }
  return { production: prod.key, user: prod.email, lastKnownDate, today: todayStr(now), missingDates };
}

/**
 * FONCTION CENTRALE UNIQUE — statut de conformité d'UNE date précise pour un
 * utilisateur PROD (A. COMPLETED / B. MISSING-AUTHORIZATION_REQUIRED (statut
 * interne "awaiting_authorization") / C. BACKFILL_AUTHORIZED / D. BACKFILLED /
 * E. PENDING / jour non travaillé → aucune ligne renvoyée, jamais un statut
 * contradictoire). Backend = seule source de vérité (§4) : dashboard PROD,
 * Production Compliance, Daily Control, Authorization Requests, contrôle
 * POST/PUT (assertCanCreate) passent tous par computeDays() ci-dessous —
 * jamais deux algorithmes différents, jamais une logique dupliquée côté
 * Flutter (qui ne fait qu'afficher le champ "status" renvoyé ici).
 */
async function getProductionComplianceStatus({ userId, email, date, now = clock(), transaction } = {}) {
  const prod = getMonitoredByEmail(email);
  if (!prod) return null;
  const d = normalizeDate(date) || todayStr(now);
  const [row] = await computeDays(prod, userId, d, d, { now, transaction });
  return row || null; // null = jour non travaillé (week-end/jour férié configuré)
}

// ── Contrôle avant création (appelé par le middleware backend) ───────────

/**
 * RÈGLE ABSOLUE (décision explicite) : toute date < aujourd'hui et >= cfg.startDate
 * exige une autorisation BACKFILL_PREVIOUS_PRODUCTION active pour CETTE date exacte
 * — qu'une fiche existe déjà ce jour-là ou non (ex. plusieurs machines le même jour
 * passé : chaque insertion supplémentaire exige elle aussi sa propre autorisation).
 * Retourne l'autorisation active si la date est déjà couverte, sinon null.
 * Utilisé à la fois par assertCanCreate() (blocage) et par requests.service.createRequest()
 * (pour savoir si une date envoyée par le client peut légitimement rejoindre la demande).
 */
async function activeBackfillAuth(userId, prod, date, now, transaction) {
  const auth = await Authorization.findOne({
    where: { userId, productionType: prod.key, productionDate: date, type: BACKFILL, revokedAt: null, usedAt: null },
    order: [["authorizedAt", "DESC"]],
    transaction,
  });
  if (!auth || (auth.expiresAt && new Date(auth.expiresAt) <= now)) return null;
  return auth;
}

/** true si `date` (< today) exige encore une autorisation de rattrapage (pas d'auth active, et pas avant cfg.startDate). */
async function isEligibleForBackfillRequest(userId, prod, date, today, now, transaction) {
  if (date >= today) return false;
  if (date < cfg.startDate) return false;
  const auth = await activeBackfillAuth(userId, prod, date, now, transaction);
  return !auth;
}

async function assertCanCreate({ email, userId, productionDate, now = clock(), transaction }) {
  const prod = getMonitoredByEmail(email);
  if (!prod || !cfg.enabled) return { allowed: true, skipped: true };

  const today = todayStr(now);
  const date = normalizeDate(productionDate) || today;

  if (date < today) {
    // Une date antérieure au début du contrôle n'est jamais "manquante" (aucun
    // historique n'est rétroactivement mis en défaut) — jamais d'autorisation exigée.
    if (date < cfg.startDate) return { allowed: true, kind: "unmonitored", production: prod, date };

    // Un jour DÉJÀ CONFORME (au moins une fiche dans la plage horaire — statut
    // "completed", EXACTEMENT le même critère que le calcul des dates manquantes,
    // computeDays()) n'exige pas d'autorisation pour une fiche SUPPLÉMENTAIRE ce
    // jour-là : plusieurs machines peuvent produire le même jour conforme, sans
    // bloquer chaque fiche derrière une nouvelle autorisation. Ne s'applique QUE si
    // le jour est réellement conforme : un jour dont les fiches sont TOUTES hors
    // plage reste "awaiting_authorization"/"backfill_authorized" et continue
    // d'exiger une autorisation pour toute création — la règle absolue (bloquer
    // toute date passée non authentiquement régularisée) reste intacte pour ce cas.
    const [dayStatus] = await computeDays(prod, userId, date, date, { now, transaction });
    if (dayStatus?.status === "completed") return { allowed: true, kind: "regular", production: prod, date };

    const auth = await activeBackfillAuth(userId, prod, date, now, transaction);
    if (!auth) {
      throw new ComplianceError(
        403,
        "BACKFILL_NOT_AUTHORIZED",
        "La création d'une fiche pour une date antérieure nécessite une autorisation.",
        "La création d'une fiche pour une date antérieure nécessite une autorisation.",
        {
          messageEn: "Creating a production sheet for a previous date requires an authorization.",
          requestedDate: date,
          missingDate: date,
          missingDates: [date],
          requiresAuthorization: true,
          authorizationType: BACKFILL,
          production: prod.key,
        }
      );
    }
    return { allowed: true, kind: "backfill", authorization: auth, production: prod, date };
  }

  const missing = await blockingDays(prod, userId, { now, transaction });
  if (missing.length > 0) {
    const dates = missing.map((r) => r.date);
    throw new ComplianceError(
      403,
      "PREVIOUS_PRODUCTION_MISSING",
      "Des fiches de production précédentes sont manquantes.",
      "Des fiches de production précédentes sont manquantes.",
      {
        messageEn: "Previous production sheets are missing.",
        // missingDate (singulier) conservé pour compatibilité — la source de vérité est missingDates[].
        missingDate: dates[0],
        missingDates: dates,
        requestedDate: date,
        authorizationType: BACKFILL,
        requiresAuthorization: true,
        backfillAuthorized: missing.every((r) => r.status === "backfill_authorized"),
        production: prod.key,
      }
    );
  }
  return { allowed: true, kind: "regular", production: prod, date };
}

async function consumeAuthorization(authId, { type, id }, now = clock(), transaction) {
  const run = async (t) => {
    const [count] = await Authorization.update(
      { usedAt: now, usedFicheType: type, usedFicheId: id },
      { where: { id: authId, usedAt: null }, transaction: t }
    );
    if (count > 0) {
      // Une demande peut couvrir plusieurs dates (plusieurs autorisations) : elle ne passe
      // à USED que lorsque TOUTES ses autorisations ont servi (rattrapage complet).
      const rows = await AuthRequest.findAll({ where: { status: "APPROVED" }, transaction: t });
      for (const row of rows) {
        const ids = Array.isArray(row.createdAuthorizationIds) && row.createdAuthorizationIds.length ? row.createdAuthorizationIds : [row.createdAuthorizationId].filter(Boolean);
        if (!ids.includes(authId)) continue;
        const auths = await Authorization.findAll({ where: { id: ids }, transaction: t });
        if (auths.length === ids.length && auths.every((a) => a.usedAt)) {
          await row.update({ status: "USED" }, { transaction: t });
        }
      }
    }
    return count;
  };
  // Autorisation et demande passent à USED ensemble (jamais d'état intermédiaire visible).
  const count = transaction ? await run(transaction) : await sequelize.transaction(run);
  if (count > 0) logger.info(`[PRODUCTION-AUTHORIZATION] AUTHORIZATION USED authorization=${authId} ficheType=${type} ficheId=${id}`);
  return count;
}

/**
 * Notification CRM (in-app) aux responsables — indépendante du SMTP : une demande
 * ou une alerte n'est jamais invisible même si l'envoi d'e-mail est en échec.
 */
async function notifyManagers({ type, title, message }, transaction) {
  let created = 0;
  try {
    const managers = await User.findAll({ where: { email: cfg.managers }, attributes: ["id", "email"], transaction });
    for (const m of managers) {
      await Notification.create({ userId: m.id, type, title: String(title).slice(0, 200), message: String(message).slice(0, 500) }, { transaction });
      created += 1;
    }
  } catch (err) {
    logger.error(`[PRODUCTION-AUTHORIZATION] manager notification failed: ${err.message}`);
  }
  return created;
}

// ── Autorisations (responsables) ─────────────────────────────────────────

async function assertManager(managerId, transaction) {
  const manager = await User.findByPk(managerId, { attributes: ["id", "email", "role", "isActive"], transaction });
  if (!manager || manager.isActive === false || !isComplianceManagerUser(manager)) {
    throw new ComplianceError(403, "NOT_A_MANAGER", "Only a production compliance manager can do this.", "Action réservée aux responsables.");
  }
  return manager;
}

async function notifyAuthorized(auth, user, now, transaction) {
  const isBackfill = auth.type === BACKFILL;
  const date = frDate(auth.productionDate);
  const title = isBackfill ? "Rattrapage de fiche autorisé" : "Passage autorisé";
  const message = isBackfill
    ? `Vous êtes autorisé à créer la fiche de production du ${date}.`
    : `Un responsable a autorisé le passage malgré la fiche manquante du ${date}.`;
  try {
    await Notification.create({ userId: user.id, type: "production_compliance_authorization", title, message }, { transaction });
  } catch (err) {
    logger.error(`[COMPLIANCE] notification failed: ${err.message}`);
  }
  if (!cfg.userEmailNotifications) return;
  try {
    const expiry = auth.expiresAt ? `\nCette autorisation expire le ${dayjs(auth.expiresAt).tz(tz).format("DD/MM/YYYY HH:mm")} (heure de Tunis).` : "";
    await mail.send({
      to: [user.email],
      subject: `${title} — ${date}`,
      text: `${message}${expiry}\n\nAutorisé par : ${auth.authorizedByEmail}\nMotif : ${auth.reason || "-"}\n\nCRM : ${cfg.crmBaseUrl}`,
      html: `<p>${message}</p>${expiry ? `<p>${expiry.trim()}</p>` : ""}<p>Autorisé par : ${auth.authorizedByEmail}<br>Motif : ${auth.reason || "-"}</p><p><a href="${cfg.crmBaseUrl}">Ouvrir le CRM</a></p>`,
    });
  } catch (err) {
    logger.error(`[COMPLIANCE] authorization email failed: ${err.message}`);
  }
}

async function createAuthorization({ managerId, productionKey, date, type, reason, now = clock(), transaction, notify = true }) {
  const manager = await assertManager(managerId, transaction);
  if (![BACKFILL, BYPASS].includes(type)) {
    throw new ComplianceError(400, "INVALID_TYPE", `type must be ${BACKFILL} or ${BYPASS}`, "Type d'autorisation invalide.");
  }
  const prod = cfg.productions[productionKey];
  if (!prod) throw new ComplianceError(400, "INVALID_PRODUCTION", "Unknown production.", "Production inconnue.");
  const d = normalizeDate(date);
  const today = todayStr(now);
  if (!d || d >= today) {
    throw new ComplianceError(400, "INVALID_DATE", "The date must be a previous date (YYYY-MM-DD).", "La date doit être antérieure à aujourd'hui.");
  }
  const user = await findUserByEmail(prod.email, transaction);
  if (!user) throw new ComplianceError(404, "USER_NOT_FOUND", `User ${prod.email} not found.`, "Utilisateur introuvable.");

  if (type === BYPASS) {
    const days = await computeDays(prod, user.id, d, d, { now, transaction });
    const row = days[0];
    if (!row || !BLOCKING.has(row.status)) {
      throw new ComplianceError(409, "NOT_MISSING", "This date is not a missing production date.", "Cette date n'est pas une fiche manquante.");
    }
  } else {
    const dup = await Authorization.findOne({
      where: { userId: user.id, productionType: prod.key, productionDate: d, type: BACKFILL, revokedAt: null, usedAt: null },
      transaction,
    });
    if (dup && (!dup.expiresAt || new Date(dup.expiresAt) > now)) {
      throw new ComplianceError(409, "ALREADY_AUTHORIZED", "A backfill authorization is already active for this date.", "Un rattrapage est déjà autorisé pour cette date.");
    }
  }

  const expiresAt = type === BACKFILL ? new Date(now.getTime() + cfg.backfillTtlHours * 3600 * 1000) : null;
  const auth = await Authorization.create(
    {
      userId: user.id,
      productionType: prod.key,
      productionDate: d,
      type,
      authorizedBy: manager.id,
      authorizedByEmail: manager.email,
      authorizedAt: now,
      expiresAt,
      reason: (reason && String(reason).trim()) || (type === BACKFILL ? `Rattrapage fiche non créée le ${frDate(d)}` : `Passage autorisé malgré la fiche manquante du ${frDate(d)}`),
    },
    { transaction }
  );
  logger.info(`[COMPLIANCE] ${type} ${prod.key} ${d} authorized by ${manager.email} (auth ${auth.id})`);
  // Une demande PENDING couvrant cette date (parmi d'éventuelles autres dates) est mise à jour :
  // APPROVED seulement si TOUTES ses dates ont désormais une autorisation active.
  if (type === BACKFILL) {
    const pending = await AuthRequest.findAll({
      where: { userId: user.id, productionType: prod.key, status: "PENDING" },
      transaction,
    });
    for (const row of pending) {
      const dates = Array.isArray(row.missingDates) && row.missingDates.length ? row.missingDates : [row.missingDate];
      if (!dates.includes(d)) continue;
      const ids = [...new Set([...(row.createdAuthorizationIds || []), auth.id])];
      const activeAuths = await Authorization.findAll({
        where: { userId: user.id, productionType: prod.key, productionDate: dates, type: BACKFILL, revokedAt: null },
        transaction,
      });
      const allCovered = dates.every((dd) => activeAuths.some((a) => a.productionDate === dd));
      await row.update(
        allCovered
          ? { status: "APPROVED", reviewedAt: now, reviewedBy: manager.id, reviewerEmail: manager.email, createdAuthorizationId: ids[0], createdAuthorizationIds: ids, expiresAt }
          : { createdAuthorizationIds: ids },
        { transaction }
      );
    }
  }
  const view = authView(auth, now);
  if (notify === "defer") return { ...view, notifyLater: (tx) => notifyAuthorized(auth, user, now, tx) };
  if (notify) await notifyAuthorized(auth, user, now, transaction);
  return view;
}

async function revokeAuthorization({ managerId, authorizationId, now = clock(), transaction }) {
  const manager = await assertManager(managerId, transaction);
  const auth = await Authorization.findByPk(authorizationId, { transaction });
  if (!auth) throw new ComplianceError(404, "NOT_FOUND", "Authorization not found.", "Autorisation introuvable.");
  if (auth.usedAt) throw new ComplianceError(409, "ALREADY_USED", "This authorization has already been used.", "Cette autorisation a déjà été utilisée.");
  if (!auth.revokedAt) await auth.update({ revokedAt: now, revokedBy: manager.id }, { transaction });
  return authView(auth, now);
}

async function listAuthorizations({ from, to, production, userId, limit = 200 } = {}) {
  const where = {};
  if (production) where.productionType = production;
  if (userId) where.userId = userId;
  const { Op } = require("sequelize");
  if (from || to) where.productionDate = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  const rows = await Authorization.findAll({ where, order: [["authorizedAt", "DESC"]], limit: Math.min(Number(limit) || 200, 1000) });
  const now = clock();
  return rows.map((a) => ({ ...authView(a, now), userId: a.userId, production: a.productionType }));
}

// ── Vues manager / utilisateur ───────────────────────────────────────────

async function getComplianceRows({ from, to, production, userId, status } = {}, { now = clock(), transaction } = {}) {
  const today = todayStr(now);
  const end = normalizeDate(to) || today;
  const start = normalizeDate(from) || shiftDate(end, -29);
  if (start > end) throw new ComplianceError(400, "INVALID_RANGE", "'from' must be before 'to'.", "La date de début doit précéder la date de fin.");
  const capped = dayjs.utc(end).diff(dayjs.utc(start), "day") > 366 ? shiftDate(end, -366) : start;

  const prods = Object.values(cfg.productions).filter((p) => !production || p.key === production);
  const out = [];
  for (const prod of prods) {
    const user = await findUserByEmail(prod.email, transaction);
    if (!user || (userId && user.id !== userId)) continue;
    const days = await computeDays(prod, user.id, capped, end, { now, transaction });
    out.push(...days);
  }
  const filtered = status ? out.filter((r) => r.status === status) : out;
  return filtered.sort((a, b) => b.date.localeCompare(a.date) || a.productionKey.localeCompare(b.productionKey));
}

/** Récapitulatif à une date : état du jour, dates manquantes, rattrapages, autorisations. */
async function getSummary({ date } = {}, { now = clock(), transaction } = {}) {
  const day = normalizeDate(date) || todayStr(now);
  const productions = [];
  for (const prod of Object.values(cfg.productions)) {
    const user = await findUserByEmail(prod.email, transaction);
    if (!user) {
      productions.push({ key: prod.key, label: prod.label, email: prod.email, userFound: false, today: null, missing: [], backfilled: [], authorizations: [] });
      continue;
    }
    const rows = await computeDays(prod, user.id, cfg.startDate, day, { now, transaction });
    productions.push({
      key: prod.key,
      label: prod.label,
      email: prod.email,
      userFound: true,
      periodStart: prod.start,
      periodEnd: prod.end,
      today: rows.find((r) => r.date === day) || null,
      missing: rows.filter((r) => ["missing", "awaiting_authorization", "backfill_authorized"].includes(r.status)),
      backfilled: rows.filter((r) => r.status === "backfilled"),
      bypassed: rows.filter((r) => r.status === "authorized_bypass"),
      authorizations: rows.flatMap((r) => r.authorizations),
    });
  }
  return { date: day, startDate: cfg.startDate, productions };
}

/** Demandes d'autorisation → vues (statut effectif : EXPIRED calculé si échue). */
async function viewRequests(rows, now = clock(), transaction) {
  const allIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.createdAuthorizationIds) && r.createdAuthorizationIds.length ? r.createdAuthorizationIds : [r.createdAuthorizationId]).filter(Boolean)))];
  const auths = allIds.length ? await Authorization.findAll({ where: { id: allIds }, transaction }) : [];
  return rows.map((r) => {
    const dates = Array.isArray(r.missingDates) && r.missingDates.length ? [...r.missingDates].sort() : [r.missingDate];
    const authIds = Array.isArray(r.createdAuthorizationIds) && r.createdAuthorizationIds.length ? r.createdAuthorizationIds : [r.createdAuthorizationId].filter(Boolean);
    const rowAuths = authIds.map((id) => auths.find((a) => a.id === id)).filter(Boolean);
    const anyActiveExpired = rowAuths.some((a) => !a.usedAt && (a.revokedAt || (a.expiresAt && new Date(a.expiresAt) <= now)));
    // Statut AFFICHÉ (jamais persisté tel quel en base — la colonne reste APPROVED
    // tant que tout n'est pas régularisé, voir consumeAuthorization) : PARTIALLY_USED
    // dès qu'au moins une date est régularisée mais pas toutes (§14/§15).
    let status = r.status;
    if (status === "PENDING" && r.expiresAt && new Date(r.expiresAt) <= now) status = "EXPIRED";
    else if (status === "APPROVED" && anyActiveExpired) status = "EXPIRED";
    else if (status === "APPROVED" && rowAuths.some((a) => a.usedAt) && rowAuths.some((a) => !a.usedAt)) status = "PARTIALLY_USED";
    return {
      id: r.id,
      userId: r.userId,
      userEmail: r.userEmail,
      production: r.productionType,
      productionLabel: cfg.productions[r.productionType]?.label || r.productionType,
      missingDate: dates[0],
      missingDates: dates,
      requestedDate: r.requestedDate,
      authorizationType: r.authorizationType,
      reason: r.reason,
      status,
      requestedAt: r.requestedAt,
      expiresAt: r.expiresAt,
      reviewedAt: r.reviewedAt,
      reviewedBy: r.reviewedBy,
      reviewerEmail: r.reviewerEmail,
      reviewNote: r.reviewNote,
      authorizationId: authIds[0] || null,
      authorizationIds: authIds,
      usedDates: rowAuths.filter((a) => a.usedAt).map((a) => a.productionDate).sort(),
      remainingDates: dates.filter((d) => !rowAuths.some((a) => a.productionDate === d && a.usedAt)),
      usedProductionRecordId: rowAuths.find((a) => a.usedAt)?.usedFicheId || null,
      usedAt: rowAuths.filter((a) => a.usedAt).map((a) => a.usedAt).sort().pop() || null,
      emailStatus: r.emailStatus,
      emailError: r.emailError,
      emailSentAt: r.emailSentAt,
      lastEmailAttemptAt: r.lastEmailAttemptAt,
      retryCount: r.retryCount,
    };
  });
}

/** Situation de l'utilisateur connecté (bannière côté formulaire). */
async function getMyStatus({ email, userId }, { now = clock(), transaction } = {}) {
  const prod = getMonitoredByEmail(email);
  const base = { isManager: isManagerEmail(email), monitored: !!prod && cfg.enabled, today: todayStr(now) };
  if (!prod || !cfg.enabled) return base;
  const blockingRows = await blockingDays(prod, userId, { now, transaction });
  const blocking = blockingRows[0] || null;
  const today = todayStr(now);
  const lastKnownDate = await lastKnownProductionDate(userId, transaction);
  const auths = await Authorization.findAll({
    where: { userId, productionType: prod.key, type: BACKFILL, revokedAt: null, usedAt: null },
    order: [["productionDate", "ASC"]],
    transaction,
  });
  return {
    ...base,
    production: prod.key,
    label: prod.label,
    periodStart: prod.start,
    periodEnd: prod.end,
    blocked: !!blocking,
    missingDate: blocking?.date || null,
    missingDates: blockingRows.map((r) => r.date),
    lastKnownDate,
    backfillDates: auths.filter((a) => !a.expiresAt || new Date(a.expiresAt) > now).map((a) => ({ date: a.productionDate, expiresAt: a.expiresAt })),
    message: blocking
      ? blockingRows.length > 1
        ? "Des fiches de production précédentes sont manquantes."
        : `La fiche de production du ${frDate(blocking.date)} est manquante. Une autorisation du Super Admin est nécessaire pour la régularisation.`
      : null,
    requests: await viewRequests(
      await AuthRequest.findAll({ where: { userId }, order: [["requestedAt", "DESC"]], limit: 20, transaction }),
      now,
      transaction
    ),
  };
}

module.exports = {
  BACKFILL,
  BYPASS,
  ComplianceError,
  cfg,
  todayStr,
  shiftDate,
  isWorkingDay,
  frDate,
  dateInTz,
  windowFor,
  normalizeDate,
  getMonitoredByEmail,
  isManagerEmail,
  isSuperAdminRole,
  isComplianceManagerUser,
  findUserByEmail,
  sheetsInRange,
  computeDays,
  blockingDays,
  blockingDates,
  viewRequests,
  assertManager,
  firstBlockingDate,
  lastKnownProductionDate,
  getMissingProductionDates,
  getProductionComplianceStatus,
  activeBackfillAuth,
  isEligibleForBackfillRequest,
  assertCanCreate,
  consumeAuthorization,
  notifyManagers,
  createAuthorization,
  revokeAuthorization,
  listAuthorizations,
  getComplianceRows,
  getSummary,
  getMyStatus,
  tzNow,
  setClock,
  getNow: () => clock(),
};
