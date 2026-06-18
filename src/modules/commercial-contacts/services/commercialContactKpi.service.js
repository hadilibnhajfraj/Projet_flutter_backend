"use strict";

const { sequelize } = require("../../../db");

const LOG        = "[CommercialContactKPI]";
const ADMIN_ROLES = ["admin", "superadmin"];

// ─── SQL helpers ──────────────────────────────────────────────────────────────
// Generates WHERE / AND snippets only when userId is provided.
// All callers pass { replacements: _rep(userId) } so the binding is always safe.

function _where(userId)    { return userId ? `WHERE "createdBy" = :userId`     : ""; }
function _whereJoin(userId){ return userId ? `WHERE cc."createdBy" = :userId`  : ""; }
function _andUser(userId)  { return userId ? `AND "createdBy" = :userId`       : ""; }
function _andUserJoin(userId){ return userId ? `AND cc."createdBy" = :userId`  : ""; }
function _rep(userId)      { return userId ? { userId }                        : {}; }

// ═══════════════════════════════════════════════════════════════════════════════
// /kpi
// ═══════════════════════════════════════════════════════════════════════════════

async function _getGlobalKPIs(userId) {
  const whereClause = _where(userId);
  console.log(`${LOG} [_getGlobalKPIs] userId=${userId ?? "null (global)"} | WHERE="${whereClause || "AUCUN FILTRE"}"`);
  const [row] = await sequelize.query(
    `SELECT
       COUNT(*)::int                                                                  AS "totalContacts",
       COALESCE(SUM("nbAppels"), 0)::int                                             AS "totalCalls",
       COUNT(DISTINCT NULLIF(TRIM("nomSociete"), ''))::int                           AS "totalCompanies",
       COUNT(DISTINCT "createdBy")::int                                              AS "totalUsers",
       COUNT(*) FILTER (WHERE statut = 'ok')::int                                   AS "contactsActifs",
       COUNT(*) FILTER (WHERE statut IN ('client_refuse','user_injoignable'))::int   AS "contactsNonValides",
       CASE WHEN COUNT(*) > 0
         THEN ROUND(SUM("nbAppels")::numeric / COUNT(*), 2)
         ELSE 0
       END                                                                           AS "averageCallsPerContact"
     FROM commercial_contacts
     ${whereClause}`,
    { replacements: _rep(userId), type: "SELECT" }
  );
  return {
    totalContacts:          row.totalContacts          ?? 0,
    totalCalls:             row.totalCalls             ?? 0,
    totalCompanies:         row.totalCompanies         ?? 0,
    totalUsers:             row.totalUsers             ?? 0,
    contactsActifs:         row.contactsActifs         ?? 0,
    contactsNonValides:     row.contactsNonValides     ?? 0,
    averageCallsPerContact: parseFloat(row.averageCallsPerContact ?? 0),
  };
}

async function _getUsersPerformance(userId) {
  const rows = await sequelize.query(
    `SELECT
       u.id                                                                          AS "userId",
       u.email,
       COUNT(cc.id)::int                                                            AS "contactsCount",
       COALESCE(SUM(cc."nbAppels"), 0)::int                                         AS "callsCount",
       COUNT(cc.id) FILTER (WHERE cc.statut = 'ok')::int                           AS "activeContacts",
       COUNT(cc.id) FILTER (WHERE cc.statut <> 'ok')::int                          AS "inactiveContacts",
       COUNT(DISTINCT NULLIF(TRIM(cc."nomSociete"), ''))::int                      AS "companiesCount",
       CASE WHEN COUNT(cc.id) > 0
         THEN ROUND(
           COUNT(cc.id) FILTER (WHERE cc.statut = 'ok')::numeric / COUNT(cc.id) * 100, 2
         )
         ELSE 0
       END                                                                          AS "successRate",
       MAX(cc."updatedAt")                                                          AS "lastActivity"
     FROM users u
     INNER JOIN commercial_contacts cc ON cc."createdBy" = u.id
     ${_whereJoin(userId)}
     GROUP BY u.id, u.email
     ORDER BY "contactsCount" DESC`,
    { replacements: _rep(userId), type: "SELECT" }
  );
  return rows.map((r) => ({
    userId:           r.userId,
    userName:         r.email ? r.email.split("@")[0] : null,
    email:            r.email,
    contactsCount:    r.contactsCount,
    callsCount:       r.callsCount,
    activeContacts:   r.activeContacts,
    inactiveContacts: r.inactiveContacts,
    companiesCount:   r.companiesCount,
    successRate:      parseFloat(r.successRate ?? 0),
    lastActivity:     r.lastActivity,
  }));
}

async function _getStatusDistribution(userId) {
  return sequelize.query(
    `SELECT statut AS status, COUNT(*)::int AS count
     FROM commercial_contacts
     ${_where(userId)}
     GROUP BY statut ORDER BY count DESC`,
    { replacements: _rep(userId), type: "SELECT" }
  );
}

async function _getTypeDistribution(userId) {
  return sequelize.query(
    `SELECT "typeClient" AS "clientType", COUNT(*)::int AS count
     FROM commercial_contacts
     ${_where(userId)}
     GROUP BY "typeClient" ORDER BY count DESC`,
    { replacements: _rep(userId), type: "SELECT" }
  );
}

async function _getMonthlyActivity(userId) {
  return sequelize.query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', cc."createdAt"), 'YYYY-MM') AS month,
       COUNT(*)::int                                            AS "newContacts",
       COALESCE(SUM(cc."nbAppels"), 0)::int                    AS calls
     FROM commercial_contacts cc
     WHERE cc."createdAt" >= NOW() - INTERVAL '12 months'
     ${_andUserJoin(userId)}
     GROUP BY DATE_TRUNC('month', cc."createdAt")
     ORDER BY DATE_TRUNC('month', cc."createdAt")`,
    { replacements: _rep(userId), type: "SELECT" }
  );
}

async function _getTopCompanies(userId) {
  return sequelize.query(
    `SELECT
       "nomSociete"                        AS company,
       COUNT(*)::int                       AS "contactsCount",
       COALESCE(SUM("nbAppels"), 0)::int   AS "callsCount"
     FROM commercial_contacts
     WHERE "nomSociete" IS NOT NULL AND TRIM("nomSociete") <> ''
     ${_andUser(userId)}
     GROUP BY "nomSociete"
     ORDER BY "contactsCount" DESC
     LIMIT 10`,
    { replacements: _rep(userId), type: "SELECT" }
  );
}

function _computeTopUsers(usersPerformance) {
  if (!usersPerformance.length) return [];
  const maxContacts = Math.max(...usersPerformance.map((u) => u.contactsCount))  || 1;
  const maxCalls    = Math.max(...usersPerformance.map((u) => u.callsCount))     || 1;
  const maxActive   = Math.max(...usersPerformance.map((u) => u.activeContacts)) || 1;
  const scored = usersPerformance.map((u) => {
    const raw =
      0.4 * (u.contactsCount  / maxContacts) +
      0.3 * (u.callsCount     / maxCalls)    +
      0.2 * (u.activeContacts / maxActive)   +
      0.1 * (u.successRate    / 100);
    return {
      userId: u.userId, userName: u.userName, email: u.email,
      score: Math.round(raw * 10000) / 100,
      contactsCount: u.contactsCount, callsCount: u.callsCount, activeContacts: u.activeContacts,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10).map((u, i) => ({ rank: i + 1, ...u }));
}

async function getCommercialContactKPI(userId = null) {
  const t0 = Date.now();
  console.log(`${LOG} [KPI] Starting... scope=${userId ? `user:${userId}` : "all"}`);
  const [
    global, usersPerformance, statusDistribution,
    typeDistribution, monthlyActivity, topCompanies,
  ] = await Promise.all([
    _getGlobalKPIs(userId),
    _getUsersPerformance(userId),
    _getStatusDistribution(userId),
    _getTypeDistribution(userId),
    _getMonthlyActivity(userId),
    _getTopCompanies(userId),
  ]);
  const topUsers = _computeTopUsers(usersPerformance);
  console.log(`${LOG} [KPI] Done in ${Date.now() - t0}ms | contacts=${global.totalContacts}`);
  return { global, usersPerformance, statusDistribution, typeDistribution, monthlyActivity, topUsers, topCompanies };
}

// ═══════════════════════════════════════════════════════════════════════════════
// /analytics
// ═══════════════════════════════════════════════════════════════════════════════

async function _getGlobalAnalytics(userId) {
  const [row] = await sequelize.query(
    `SELECT
       COUNT(*)::int                                                                  AS "totalContacts",
       COALESCE(SUM("nbAppels"), 0)::int                                             AS "totalCalls",
       COUNT(DISTINCT NULLIF(TRIM("nomSociete"), ''))::int                           AS "totalCompanies",
       COUNT(DISTINCT "createdBy")::int                                              AS "totalCommercials",
       COUNT(*) FILTER (WHERE statut = 'ok')::int                                   AS "activeContacts",
       COUNT(*) FILTER (WHERE statut <> 'ok')::int                                  AS "inactiveContacts",
       CASE WHEN COUNT(*) > 0
         THEN ROUND(SUM("nbAppels")::numeric / COUNT(*), 2)
         ELSE 0
       END                                                                           AS "averageCallsPerContact"
     FROM commercial_contacts
     ${_where(userId)}`,
    { replacements: _rep(userId), type: "SELECT" }
  );
  return {
    totalContacts:          row.totalContacts          ?? 0,
    totalCalls:             row.totalCalls             ?? 0,
    totalCompanies:         row.totalCompanies         ?? 0,
    totalCommercials:       row.totalCommercials       ?? 0,
    activeContacts:         row.activeContacts         ?? 0,
    inactiveContacts:       row.inactiveContacts       ?? 0,
    averageCallsPerContact: parseFloat(row.averageCallsPerContact ?? 0),
  };
}

async function _getUsersPerformanceAnalytics(userId) {
  const rows = await sequelize.query(
    `SELECT
       u.id                                                                          AS "userId",
       u.email,
       COUNT(cc.id)::int                                                            AS "contactsCount",
       COALESCE(SUM(cc."nbAppels"), 0)::int                                         AS "callsCount",
       COUNT(cc.id) FILTER (WHERE cc.statut = 'ok')::int                           AS "activeContacts",
       COUNT(cc.id) FILTER (WHERE cc.statut <> 'ok')::int                          AS "inactiveContacts",
       COUNT(DISTINCT NULLIF(TRIM(cc."nomSociete"), ''))::int                      AS "companiesCount",
       CASE WHEN COUNT(cc.id) > 0
         THEN ROUND(
           COUNT(cc.id) FILTER (WHERE cc.statut = 'ok')::numeric / COUNT(cc.id) * 100, 2
         )
         ELSE 0
       END                                                                          AS "validationRate"
     FROM users u
     INNER JOIN commercial_contacts cc ON cc."createdBy" = u.id
     ${_whereJoin(userId)}
     GROUP BY u.id, u.email
     ORDER BY "contactsCount" DESC`,
    { replacements: _rep(userId), type: "SELECT" }
  );
  if (!rows.length) return [];
  const maxContacts  = Math.max(...rows.map((r) => Number(r.contactsCount)))  || 1;
  const maxCalls     = Math.max(...rows.map((r) => Number(r.callsCount)))     || 1;
  const maxCompanies = Math.max(...rows.map((r) => Number(r.companiesCount))) || 1;
  const mapped = rows.map((r) => {
    const validationRate = parseFloat(r.validationRate ?? 0);
    const raw =
      0.4 * (Number(r.contactsCount)  / maxContacts)  +
      0.3 * (Number(r.callsCount)     / maxCalls)     +
      0.2 * (validationRate           / 100)          +
      0.1 * (Number(r.companiesCount) / maxCompanies);
    return {
      userId: r.userId, userName: r.email ? r.email.split("@")[0] : null, email: r.email,
      contactsCount:    Number(r.contactsCount),
      callsCount:       Number(r.callsCount),
      activeContacts:   Number(r.activeContacts),
      inactiveContacts: Number(r.inactiveContacts),
      companiesCount:   Number(r.companiesCount),
      validationRate,
      crmScore: Math.round(raw * 10000) / 100,
    };
  });
  mapped.sort((a, b) => b.crmScore - a.crmScore);
  return mapped.map((u, i) => ({ ...u, rank: i + 1 }));
}

const _BADGES = ["Or", "Argent", "Bronze"];

function _computeTopCommercials(usersPerformance) {
  if (!usersPerformance.length) return [];
  const maxContacts   = Math.max(...usersPerformance.map((u) => u.contactsCount))   || 1;
  const maxCalls      = Math.max(...usersPerformance.map((u) => u.callsCount))      || 1;
  const maxCompanies  = Math.max(...usersPerformance.map((u) => u.companiesCount))  || 1;
  const maxValidation = Math.max(...usersPerformance.map((u) => u.validationRate))  || 1;
  return usersPerformance.slice(0, 10).map((u, i) => {
    const reasons = [];
    if (u.contactsCount  / maxContacts   >= 0.8) reasons.push("Plus grand portefeuille contacts");
    if (u.callsCount     / maxCalls      >= 0.8) reasons.push("Très forte activité téléphonique");
    if (u.validationRate / maxValidation >= 0.8) reasons.push("Excellent taux validation");
    if (u.companiesCount / maxCompanies  >= 0.7) reasons.push("Large couverture entreprises");
    if (!reasons.length)                         reasons.push("Bonne performance globale");
    return {
      rank: i + 1, badge: _BADGES[i] ?? "Actif",
      userName: u.userName, email: u.email, score: u.crmScore,
      contactsCount: u.contactsCount, callsCount: u.callsCount,
      validationRate: u.validationRate, reason: reasons,
    };
  });
}

async function _getStatusDistributionWithPct(userId) {
  return sequelize.query(
    `SELECT
       statut        AS status,
       COUNT(*)::int AS count,
       ROUND(COUNT(*)::numeric / NULLIF(SUM(COUNT(*)) OVER (), 0) * 100, 2) AS percentage
     FROM commercial_contacts
     ${_where(userId)}
     GROUP BY statut ORDER BY count DESC`,
    { replacements: _rep(userId), type: "SELECT" }
  );
}

async function _getTypeDistributionWithPct(userId) {
  return sequelize.query(
    `SELECT
       "typeClient"    AS "clientType",
       COUNT(*)::int   AS count,
       ROUND(COUNT(*)::numeric / NULLIF(SUM(COUNT(*)) OVER (), 0) * 100, 2) AS percentage
     FROM commercial_contacts
     ${_where(userId)}
     GROUP BY "typeClient" ORDER BY count DESC`,
    { replacements: _rep(userId), type: "SELECT" }
  );
}

function _contactsByCommercial(usersPerformance) {
  return [...usersPerformance]
    .sort((a, b) => b.contactsCount - a.contactsCount)
    .map((u) => ({ userName: u.userName, contactsCount: u.contactsCount }));
}

function _callsByCommercial(usersPerformance) {
  return [...usersPerformance]
    .sort((a, b) => b.callsCount - a.callsCount)
    .map((u) => ({ userName: u.userName, callsCount: u.callsCount }));
}

async function _getMonthlyActivityAnalytics(userId) {
  return sequelize.query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', cc."createdAt"), 'YYYY-MM') AS month,
       COUNT(*)::int                                            AS "contactsCreated",
       COALESCE(SUM(cc."nbAppels"), 0)::int                    AS calls
     FROM commercial_contacts cc
     WHERE cc."createdAt" >= NOW() - INTERVAL '12 months'
     ${_andUserJoin(userId)}
     GROUP BY DATE_TRUNC('month', cc."createdAt")
     ORDER BY DATE_TRUNC('month', cc."createdAt")`,
    { replacements: _rep(userId), type: "SELECT" }
  );
}

async function getCommercialContactAnalytics(userId = null) {
  const t0 = Date.now();
  console.log(`${LOG} [Analytics] Starting... scope=${userId ? `user:${userId}` : "all"}`);
  const [
    global, usersPerformance, statusDistribution,
    typeDistribution, monthlyActivity, topCompanies,
  ] = await Promise.all([
    _getGlobalAnalytics(userId),
    _getUsersPerformanceAnalytics(userId),
    _getStatusDistributionWithPct(userId),
    _getTypeDistributionWithPct(userId),
    _getMonthlyActivityAnalytics(userId),
    _getTopCompanies(userId),
  ]);
  const topCommercials       = _computeTopCommercials(usersPerformance);
  const contactsByCommercial = _contactsByCommercial(usersPerformance);
  const callsByCommercial    = _callsByCommercial(usersPerformance);
  console.log(
    `${LOG} [Analytics] Done in ${Date.now() - t0}ms | contacts=${global.totalContacts} commercials=${global.totalCommercials}`
  );
  return {
    global, usersPerformance, topCommercials,
    statusDistribution, typeDistribution,
    contactsByCommercial, callsByCommercial,
    topCompanies, monthlyActivity,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// /kpi/me  — vue personnelle du commercial connecté
// ═══════════════════════════════════════════════════════════════════════════════

async function _getMyGlobal(userId) {
  const [row] = await sequelize.query(
    `SELECT
       COUNT(*)::int                                                          AS "totalContacts",
       COALESCE(SUM("nbAppels"), 0)::int                                     AS "totalCalls",
       COUNT(DISTINCT NULLIF(TRIM("nomSociete"), ''))::int                   AS "totalCompanies",
       COUNT(*) FILTER (WHERE statut = 'ok')::int                           AS "validatedContacts",
       COUNT(*) FILTER (WHERE statut <> 'ok')::int                          AS "invalidContacts"
     FROM commercial_contacts
     WHERE "createdBy" = :userId`,
    { replacements: { userId }, type: "SELECT" }
  );
  return {
    totalContacts:     row.totalContacts     ?? 0,
    totalCalls:        row.totalCalls        ?? 0,
    totalCompanies:    row.totalCompanies    ?? 0,
    validatedContacts: row.validatedContacts ?? 0,
    invalidContacts:   row.invalidContacts   ?? 0,
  };
}

async function _getMyStatusDistribution(userId) {
  return sequelize.query(
    `SELECT statut AS status, COUNT(*)::int AS count
     FROM commercial_contacts
     WHERE "createdBy" = :userId
     GROUP BY statut ORDER BY count DESC`,
    { replacements: { userId }, type: "SELECT" }
  );
}

async function _getMyTypeDistribution(userId) {
  return sequelize.query(
    `SELECT "typeClient" AS "clientType", COUNT(*)::int AS count
     FROM commercial_contacts
     WHERE "createdBy" = :userId
     GROUP BY "typeClient" ORDER BY count DESC`,
    { replacements: { userId }, type: "SELECT" }
  );
}

async function _getMonthlyCalls(userId) {
  return sequelize.query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') AS month,
       COALESCE(SUM("nbAppels"), 0)::int                    AS calls
     FROM commercial_contacts
     WHERE "createdBy" = :userId
       AND "createdAt" >= NOW() - INTERVAL '12 months'
     GROUP BY DATE_TRUNC('month', "createdAt")
     ORDER BY DATE_TRUNC('month', "createdAt")`,
    { replacements: { userId }, type: "SELECT" }
  );
}

async function getMyKPI(userId) {
  const t0 = Date.now();
  console.log(`${LOG} [MyKPI] Starting... userId=${userId}`);
  const [global, contactsByStatus, contactsByType, monthlyCalls] = await Promise.all([
    _getMyGlobal(userId),
    _getMyStatusDistribution(userId),
    _getMyTypeDistribution(userId),
    _getMonthlyCalls(userId),
  ]);
  console.log(`${LOG} [MyKPI] Done in ${Date.now() - t0}ms | contacts=${global.totalContacts}`);
  return {
    totalContacts:     global.totalContacts,
    totalCalls:        global.totalCalls,
    totalCompanies:    global.totalCompanies,
    validatedContacts: global.validatedContacts,
    invalidContacts:   global.invalidContacts,
    contactsByStatus,
    contactsByType,
    monthlyCalls,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// /kpi  — vue personnelle commercial (réponse enrichie)
// ═══════════════════════════════════════════════════════════════════════════════
async function getPersonalKPISummary(userId, commercialName = null) {
  const t0 = Date.now();
  console.log(`${LOG} [PersonalKPI] Starting... userId=${userId} commercialName=${commercialName ?? "none"}`);

  // Si commercialName fourni : filtre par user_nom / user_nom_custom
  // Sinon : filtre par createdBy = userId (comportement historique)
  const whereClause = commercialName
    ? `WHERE ("user_nom" = :commercialName OR "user_nom_custom" = :commercialName)`
    : `WHERE "createdBy" = :userId`;
  const replacements = commercialName
    ? { userId, commercialName }
    : { userId };

  const [globalRows, statusDistribution, typeDistribution] = await Promise.all([
    sequelize.query(
      `SELECT
         COUNT(*)::int                                                          AS "totalContacts",
         COALESCE(SUM("nbAppels"), 0)::int                                     AS "totalCalls",
         COUNT(DISTINCT NULLIF(TRIM("nomSociete"), ''))::int                   AS "totalCompanies",
         CASE WHEN COUNT(*) > 0
           THEN ROUND(
             COUNT(*) FILTER (WHERE statut = 'ok')::numeric / COUNT(*) * 100,
             2
           )
           ELSE 0
         END                                                                   AS "validationRate"
       FROM commercial_contacts
       ${whereClause}`,
      { replacements, type: "SELECT" }
    ),
    sequelize.query(
      `SELECT
         statut        AS status,
         COUNT(*)::int AS count
       FROM commercial_contacts
       ${whereClause}
       GROUP BY statut
       ORDER BY count DESC`,
      { replacements, type: "SELECT" }
    ),
    sequelize.query(
      `SELECT
         "typeClient"    AS "clientType",
         COUNT(*)::int   AS count
       FROM commercial_contacts
       ${whereClause}
       GROUP BY "typeClient"
       ORDER BY count DESC`,
      { replacements, type: "SELECT" }
    ),
  ]);

  const row = globalRows[0] ?? {};

  console.log(`${LOG} [PersonalKPI] Done in ${Date.now() - t0}ms | contacts=${row.totalContacts ?? 0}`);

  return {
    totalContacts:    row.totalContacts     ?? 0,
    totalCalls:       row.totalCalls        ?? 0,
    totalCompanies:   row.totalCompanies    ?? 0,
    validationRate:   parseFloat(row.validationRate ?? 0),
    contactsByStatus: statusDistribution,
    contactsByType:   typeDistribution,
  };
}

module.exports = {
  ADMIN_ROLES,
  getCommercialContactKPI,
  getCommercialContactAnalytics,
  getMyKPI,
  getPersonalKPISummary,
};
