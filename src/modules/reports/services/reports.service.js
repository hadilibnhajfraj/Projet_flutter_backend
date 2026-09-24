"use strict";

const dayjs = require("dayjs");
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../../../db");
const { makeT, normLang } = require("./reportsI18n");

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[0-9a-zA-Z-]{1,64}$/;

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function run(sql, replacements = {}) {
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

const NAME = (u, up) =>
  `COALESCE(NULLIF(TRIM(${up}.name),''), NULLIF(TRIM(CONCAT_WS(' ', ${up}.prenom, ${up}.nom)),''), ${u}.email)`;

// Fichiers de filtres normalisés à partir de req.query
function parseFilters(rawQuery = {}) {
  const query = { ...rawQuery };
  const aliases = { salesRep: "commercialId", user: "userId", projectStatus: "statut", project: "projectId", client: "companyId", shift: "poste" };
  for (const [alias, key] of Object.entries(aliases)) {
    if (query[alias] && !query[key]) query[key] = query[alias];
  }
  const f = {};
  if (query.from) {
    const d = dayjs(query.from);
    if (!d.isValid()) throw badRequest("Invalid 'from' date");
    f.from = d.startOf("day").toDate();
  }
  if (query.to) {
    const d = dayjs(query.to);
    if (!d.isValid()) throw badRequest("Invalid 'to' date");
    f.toEx = d.startOf("day").add(1, "day").toDate();
  }
  if (f.from && f.toEx && f.from >= f.toEx) throw badRequest("'from' must be before 'to'");
  for (const k of ["commercialId", "userId"]) {
    if (query[k]) {
      if (!UUID_RE.test(String(query[k]))) throw badRequest(`Invalid '${k}'`);
      f[k] = String(query[k]);
    }
  }
  for (const k of ["projectId", "companyId"]) {
    if (query[k]) {
      if (!ID_RE.test(String(query[k]))) throw badRequest(`Invalid '${k}'`);
      f[k] = String(query[k]);
    }
  }
  if (query.statut) f.statut = String(query.statut).slice(0, 100);
  if (query.machine) f.machine = String(query.machine).slice(0, 50);
  if (query.poste) f.poste = String(query.poste).toLowerCase().slice(0, 30);
  if (query.diameter) f.diameter = String(query.diameter).slice(0, 30);
  if (query.module) {
    const m = String(query.module).toLowerCase();
    if (!["promesh", "probar"].includes(m)) throw badRequest("Invalid 'module'");
    f.module = m;
  }
  f.lang = normLang(query.lang);
  return f;
}

function repl(f, extra = {}) {
  const r = { ...extra };
  for (const k of [
    "from", "toEx", "commercialId", "userId", "projectId", "companyId",
    "statut", "machine", "poste", "diameter",
  ]) {
    if (f[k] != null) r[k] = f[k];
  }
  return r;
}

const rng = (col, f) =>
  (f.from ? ` AND ${col} >= :from` : "") + (f.toEx ? ` AND ${col} < :toEx` : "");

const projCond = (f, a = "p") =>
  (f.commercialId ? ` AND ${a}."ownerId" = :commercialId` : "") +
  (f.statut ? ` AND ${a}.statut = :statut` : "") +
  (f.projectId ? ` AND ${a}.id::text = :projectId` : "") +
  (f.companyId ? ` AND ${a}."companyId"::text = :companyId` : "");

const contactCond = (f, a = "c") =>
  f.commercialId ? ` AND (${a}."createdBy" = :commercialId OR ${a}."commercialId" = :commercialId)` : "";

const promeshCond = (f, a = "pp") =>
  rng(`${a}."dateProduction"`, f) +
  (f.machine ? ` AND ${a}.machine = :machine` : "") +
  (f.poste ? ` AND ${a}.poste::text = :poste` : "") +
  (f.userId ? ` AND ${a}."createdBy" = :userId` : "") +
  (f.diameter ? ` AND ${a}."diametreMaille1"::text = :diameter` : "");

const probarCond = (f, a = "ir") =>
  ` AND ${a}.module = 'probar'` +
  rng(`${a}."dateFiche"`, f) +
  (f.machine ? ` AND ${a}.machine = :machine` : "") +
  (f.poste ? ` AND ${a}.poste::text = :poste` : "") +
  (f.userId ? ` AND ${a}."createdBy" = :userId` : "");

const recupCond = (f, a = "rf") =>
  rng(`${a}."date"`, f) +
  (f.machine ? ` AND ${a}.machine = :machine` : "") +
  (f.poste ? ` AND ${a}.poste::text = :poste` : "") +
  (f.userId ? ` AND ${a}."createdBy" = :userId` : "") +
  (f.module ? ` AND LOWER(${a}.module::text) = '${f.module}'` : "");

const SHIFT = (col) => `COALESCE(NULLIF(TRIM(LOWER(${col}::text)),''), 'unknown')`;
const MACHINE = (col) => `COALESCE(NULLIF(TRIM(${col}),''), 'unknown')`;

function previousPeriod(f) {
  if (!f.from || !f.toEx) return null;
  const len = f.toEx.getTime() - f.from.getTime();
  return { ...f, from: new Date(f.from.getTime() - len), toEx: f.from };
}

function variation(cur, prev) {
  if (prev == null || prev === 0 || cur == null) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

// ─────────────────────────────────────────────────────────────
// Overview / KPI
// ─────────────────────────────────────────────────────────────

async function periodKpis(f) {
  const pc = projCond(f);
  const cc = contactCond(f);
  const ficheUser = f.userId ? ` AND x."createdBy" = :userId` : "";
  const [row] = await run(
    `SELECT
      (SELECT COUNT(*) FROM projects p WHERE 1=1 ${pc} ${rng('p."createdAt"', f)})::int AS "projectsCreated",
      (SELECT COUNT(*) FROM projects p WHERE 1=1 ${pc} ${rng('p."updatedAt"', f)})::int AS "projectsModified",
      (SELECT COUNT(*) FROM projects p WHERE p."isArchived" = true ${pc} ${rng('p."archivedAt"', f)})::int AS "projectsArchivedPeriod",
      (SELECT COUNT(*) FROM commercial_contacts c WHERE 1=1 ${cc} ${rng('c."createdAt"', f)})::int AS "newContacts",
      (
        (SELECT COUNT(*) FROM por_promesh x WHERE 1=1 ${rng('x."createdAt"', f)} ${ficheUser})
        + (SELECT COUNT(*) FROM industrial_records x WHERE 1=1 ${rng('x."createdAt"', f)} ${ficheUser})
        + (SELECT COUNT(*) FROM recuperable_fiches x WHERE 1=1 ${rng('x."createdAt"', f)} ${ficheUser})
      )::int AS "totalFiches",
      (SELECT COALESCE(SUM(pp."productionM2"),0) FROM por_promesh pp WHERE 1=1 ${promeshCond(f)})::float8 AS "promeshProduction",
      (SELECT COALESCE(SUM(ir."quantiteProduite"),0) FROM industrial_records ir WHERE 1=1 ${probarCond(f)})::float8 AS "probarProduction"`,
    repl(f)
  );
  return row;
}

async function overview(f) {
  const pc = projCond(f);
  const cc = contactCond(f);
  const prevF = previousPeriod(f);

  const [cur, prev, [state], byStatus, byMonth, shifts] = await Promise.all([
    periodKpis(f),
    prevF ? periodKpis(prevF) : Promise.resolve(null),
    run(
      `SELECT
        (SELECT COUNT(*) FROM projects p WHERE 1=1 ${pc})::int AS "totalProjects",
        (SELECT COUNT(*) FROM projects p WHERE p."isArchived" = true ${pc})::int AS "projectsArchived",
        (SELECT COUNT(*) FROM commercial_contacts c WHERE 1=1 ${cc})::int AS "totalContacts",
        (SELECT COUNT(*) FROM users)::int AS "totalUsers",
        (SELECT COUNT(*) FROM users WHERE "isActive" = true)::int AS "enabledUsers"`,
      repl(f)
    ),
    run(
      `SELECT COALESCE(NULLIF(TRIM(p.statut),''), ps.name, 'unknown') AS label, COUNT(*)::int AS value
       FROM projects p LEFT JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
       WHERE 1=1 ${pc}
       GROUP BY 1 ORDER BY value DESC`,
      repl(f)
    ),
    run(
      `SELECT to_char(date_trunc('month', p."createdAt"), 'YYYY-MM') AS label, COUNT(*)::int AS value
       FROM projects p WHERE 1=1 ${pc} ${f.from || f.toEx ? rng('p."createdAt"', f) : ` AND p."createdAt" >= NOW() - INTERVAL '12 months'`}
       GROUP BY 1 ORDER BY 1`,
      repl(f)
    ),
    run(
      `SELECT s.shift AS label, SUM(s.n)::int AS value FROM (
         SELECT ${SHIFT("pp.poste")} AS shift, COUNT(*) AS n FROM por_promesh pp WHERE 1=1 ${promeshCond(f)} GROUP BY 1
         UNION ALL
         SELECT ${SHIFT("ir.poste")} AS shift, COUNT(*) AS n FROM industrial_records ir WHERE 1=1 ${probarCond(f)} GROUP BY 1
       ) s GROUP BY s.shift ORDER BY value DESC`,
      repl(f)
    ),
  ]);

  const usersRows = await users(f);
  const usersWithActivity = usersRows.filter((u) => u.lastActivityInPeriod).length;

  const kpi = (key, value, prevValue) => ({
    key,
    value,
    previous: prevF ? prevValue ?? null : null,
    variationPct: prevF ? variation(value, prevValue) : null,
  });

  const [totals] = await run(
    `SELECT
      ((SELECT COUNT(*) FROM project_actions) + (SELECT COUNT(*) FROM commercial_contact_actions))::int AS "totalActions",
      (SELECT COUNT(*) FROM commercial_contact_relances)::int AS "totalFollowUps",
      ((SELECT COUNT(*) FROM finance_documents) + (SELECT COUNT(*) FROM project_devis) + (SELECT COUNT(*) FROM project_bon_de_commande))::int AS "totalDocuments",
      ((SELECT COUNT(*) FROM por_promesh) + (SELECT COUNT(*) FROM industrial_records WHERE module = 'probar'))::int AS "totalProductionRecords"`
  );

  return {
    summary: {
      totalProjects: state.totalProjects,
      projectsCreated: cur.projectsCreated,
      projectsUpdated: cur.projectsModified,
      archivedProjects: state.projectsArchived,
      totalContacts: state.totalContacts,
      totalUsers: state.totalUsers,
      totalActions: totals.totalActions,
      totalFollowUps: totals.totalFollowUps,
      totalDocuments: totals.totalDocuments,
      totalProductionRecords: totals.totalProductionRecords,
    },
    period: { from: iso(f.from), to: f.toEx ? iso(dayjs(f.toEx).subtract(1, "day").toDate()) : null },
    previousPeriod: prevF ? { from: iso(prevF.from), to: iso(dayjs(prevF.toEx).subtract(1, "day").toDate()) } : null,
    kpis: [
      kpi("totalProjects", state.totalProjects),
      kpi("projectsCreated", cur.projectsCreated, prev?.projectsCreated),
      kpi("projectsModified", cur.projectsModified, prev?.projectsModified),
      kpi("projectsArchived", state.projectsArchived),
      kpi("projectsArchivedPeriod", cur.projectsArchivedPeriod, prev?.projectsArchivedPeriod),
      kpi("totalContacts", state.totalContacts),
      kpi("newContacts", cur.newContacts, prev?.newContacts),
      kpi("totalUsers", state.totalUsers),
      kpi("activeUsers", usersWithActivity),
      kpi("totalFiches", cur.totalFiches, prev?.totalFiches),
      kpi("promeshProduction", cur.promeshProduction, prev?.promeshProduction),
      kpi("probarProduction", cur.probarProduction, prev?.probarProduction),
    ],
    charts: { projectsByStatus: byStatus, projectsByMonth: byMonth, shifts },
  };
}

// ─────────────────────────────────────────────────────────────
// Commerciaux
// ─────────────────────────────────────────────────────────────

async function commercials(f) {
  const pc = projCond(f, "p");
  const cc = contactCond(f, "c");
  const rows = await run(
    `SELECT u.id, ${NAME("u", "up")} AS name, u.email,
      (SELECT COUNT(*) FROM projects p WHERE p."ownerId" = u.id ${pc} ${rng('p."createdAt"', f)})::int AS "projectsCreated",
      (SELECT COUNT(*) FROM projects p WHERE p."ownerId" = u.id ${pc})::int AS "projectsOwned",
      (SELECT COUNT(*) FROM projects p LEFT JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
         WHERE p."ownerId" = u.id ${pc} AND p."isArchived" = false
           AND COALESCE(ps."isWonStage", false) = false AND COALESCE(ps."isLostStage", false) = false)::int AS "projectsActive",
      (SELECT COUNT(*) FROM projects p JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
         WHERE p."ownerId" = u.id ${pc} AND ps."isWonStage" = true)::int AS "projectsWon",
      (SELECT COUNT(*) FROM projects p JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
         WHERE p."ownerId" = u.id ${pc} AND ps."isLostStage" = true)::int AS "projectsLost",
      (SELECT COUNT(*) FROM projects p WHERE p."ownerId" = u.id AND p."isArchived" = true ${pc})::int AS "projectsArchived",
      (SELECT COUNT(*) FROM commercial_contacts c WHERE c."createdBy" = u.id ${cc} ${rng('c."createdAt"', f)})::int AS "contactsCreated",
      (
        (SELECT COUNT(*) FROM project_actions x WHERE x."createdBy" = u.id ${rng('x."createdAt"', f)})
        + (SELECT COUNT(*) FROM commercial_contact_actions x WHERE x."createdBy" = u.id ${rng('x."createdAt"', f)})
      )::int AS "actions",
      (SELECT COUNT(*) FROM commercial_contact_relances x WHERE x."createdBy" = u.id ${rng('x."createdAt"', f)})::int AS "relances",
      (SELECT p."nomProjet" FROM projects p WHERE p."ownerId" = u.id ${pc} ORDER BY p."createdAt" DESC LIMIT 1) AS "lastProject",
      (SELECT p."createdAt" FROM projects p WHERE p."ownerId" = u.id ${pc} ORDER BY p."createdAt" DESC LIMIT 1) AS "lastProjectAt",
      GREATEST(
        (SELECT MAX(p."updatedAt") FROM projects p WHERE p."ownerId" = u.id),
        (SELECT MAX(x."createdAt") FROM project_activities x WHERE x."userId" = u.id),
        (SELECT MAX(x."createdAt") FROM project_actions x WHERE x."createdBy" = u.id),
        (SELECT MAX(x."createdAt") FROM commercial_contacts x WHERE x."createdBy" = u.id),
        (SELECT MAX(x."createdAt") FROM commercial_contact_actions x WHERE x."createdBy" = u.id),
        (SELECT MAX(x."createdAt") FROM commercial_contact_relances x WHERE x."createdBy" = u.id)
      ) AS "lastActivityAt"
     FROM users u LEFT JOIN user_profiles up ON up."userId" = u.id
     WHERE (u.role = 'commercial'
        OR EXISTS (SELECT 1 FROM projects p WHERE p."ownerId" = u.id)
        OR EXISTS (SELECT 1 FROM commercial_contacts c WHERE c."createdBy" = u.id OR c."commercialId" = u.id))
       ${f.commercialId ? " AND u.id = :commercialId" : ""}
     ORDER BY "projectsCreated" DESC, name ASC`,
    repl(f)
  );
  return rows.map((r) => ({
    ...r,
    commercial: r.name,
    followUps: r.relances,
    lastProjectCreatedAt: r.lastProjectAt,
    lastActivityAt: r.lastActivityAt,
  }));
}

// ─────────────────────────────────────────────────────────────
// Projets (traçabilité) + archivés
// ─────────────────────────────────────────────────────────────

async function projects(f, { archivedOnly = false, limit = 200, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 5000);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  let periodCond = "";
  if (f.from || f.toEx) {
    periodCond = archivedOnly
      ? rng('COALESCE(p."archivedAt", p."updatedAt")', f)
      : ` AND ((1=1 ${rng('p."createdAt"', f)}) OR (1=1 ${rng('p."updatedAt"', f)}))`;
  }
  const where = `WHERE 1=1 ${projCond(f)} ${archivedOnly ? 'AND p."isArchived" = true' : ""} ${periodCond}`;

  const from = `
    FROM projects p
    LEFT JOIN companies co ON co.id = p."companyId"
    LEFT JOIN pipeline_stages ps ON ps.id = p."pipelineStageId"
    LEFT JOIN users uo ON uo.id = p."ownerId" LEFT JOIN user_profiles upo ON upo."userId" = uo.id
    LEFT JOIN LATERAL (
      SELECT pa."userId", pa."createdAt" FROM project_activities pa
      WHERE pa."projectId" = p.id AND pa.type IN ('edit','stage_change')
      ORDER BY pa."createdAt" DESC LIMIT 1) lm ON true
    LEFT JOIN users um ON um.id = lm."userId" LEFT JOIN user_profiles upm ON upm."userId" = um.id
    LEFT JOIN LATERAL (
      SELECT ar."approvedBy", ar."approvedAt" FROM archive_requests ar
      WHERE ar."projectId" = p.id AND ar.type = 'ARCHIVAGE' AND ar.status = 'approved'
      ORDER BY ar."approvedAt" DESC NULLS LAST LIMIT 1) arc ON true
    LEFT JOIN users ua ON ua.id = arc."approvedBy" LEFT JOIN user_profiles upa ON upa."userId" = ua.id
    LEFT JOIN LATERAL (
      SELECT MAX(x."dateAction") AS "lastActionAt", MAX(x."createdAt") AS "lastActionCreated"
      FROM project_actions x WHERE x."projectId" = p.id) la ON true`;

  const [rows, [{ total }]] = await Promise.all([
    run(
      `SELECT p.id, p."nomProjet" AS name,
        COALESCE(co.name, NULLIF(TRIM(p.entreprise),'')) AS client,
        p."ownerId" AS "ownerId", ${NAME("uo", "upo")} AS owner,
        COALESCE(NULLIF(TRIM(p.statut),''), ps.name) AS status,
        p."createdAt", p."updatedAt",
        um.id AS "updatedById", ${NAME("um", "upm")} AS "updatedBy", lm."createdAt" AS "updatedByAt",
        p."isArchived", p."archivedAt", p."archiveReason",
        ua.id AS "archivedById", ${NAME("ua", "upa")} AS "archivedBy", arc."approvedAt" AS "archivedByAt",
        la."lastActionAt", p."lastRelanceAt",
        GREATEST(p."updatedAt", lm."createdAt", la."lastActionCreated") AS "lastActivityAt"
       ${from} ${where}
       ORDER BY ${archivedOnly ? 'COALESCE(p."archivedAt", p."updatedAt")' : 'p."updatedAt"'} DESC
       LIMIT :limit OFFSET :offset`,
      repl(f, { limit: lim, offset: off })
    ),
    run(`SELECT COUNT(*)::int AS total ${from} ${where}`, repl(f)),
  ]);
  const mapped = rows.map((r) => ({
    ...r,
    project: r.name,
    commercial: r.owner,
    createdBy: null, // aucun champ createdBy sur projects
    status: r.status,
  }));
  return { total, rows: mapped };
}

// ─────────────────────────────────────────────────────────────
// Contacts
// ─────────────────────────────────────────────────────────────

async function contacts(f) {
  const cc = contactCond(f, "c");
  const [rows, [unassigned], recent] = await Promise.all([
    run(
      `SELECT u.id, ${NAME("u", "up")} AS name,
        (SELECT COUNT(*) FROM commercial_contacts c WHERE c."createdBy" = u.id ${cc} ${rng('c."createdAt"', f)})::int AS "contactsCreated",
        (SELECT COUNT(*) FROM commercial_contacts c WHERE c."createdBy" = u.id ${cc})::int AS "contactsTotal",
        (SELECT COALESCE(NULLIF(TRIM(c."nomSociete"),''), TRIM(CONCAT_WS(' ', c.prenom, c.nom))) FROM commercial_contacts c WHERE c."createdBy" = u.id ${cc} ORDER BY c."createdAt" DESC LIMIT 1) AS "lastContact",
        (SELECT MAX(c."createdAt") FROM commercial_contacts c WHERE c."createdBy" = u.id ${cc}) AS "lastContactAt",
        (SELECT MAX(c."updatedAt") FROM commercial_contacts c WHERE c."createdBy" = u.id ${cc}) AS "lastModifiedAt",
        GREATEST(
          (SELECT MAX(c."updatedAt") FROM commercial_contacts c WHERE c."createdBy" = u.id ${cc}),
          (SELECT MAX(x."createdAt") FROM commercial_contact_actions x WHERE x."createdBy" = u.id),
          (SELECT MAX(x."createdAt") FROM commercial_contact_relances x WHERE x."createdBy" = u.id)
        ) AS "lastActivityAt"
       FROM users u LEFT JOIN user_profiles up ON up."userId" = u.id
       WHERE EXISTS (SELECT 1 FROM commercial_contacts c WHERE c."createdBy" = u.id ${cc})
       ORDER BY "contactsCreated" DESC, name ASC`,
      repl(f)
    ),
    run(
      `SELECT COUNT(*)::int AS n FROM commercial_contacts c WHERE c."commercialId" IS NULL ${rng('c."createdAt"', f)}`,
      repl(f)
    ),
    run(
      `SELECT c.id, COALESCE(NULLIF(TRIM(c."nomSociete"),''), TRIM(CONCAT_WS(' ', c.prenom, c.nom))) AS name,
        c.statut, c."createdAt", c."updatedAt", ${NAME("u", "up")} AS "createdBy"
       FROM commercial_contacts c LEFT JOIN users u ON u.id = c."createdBy" LEFT JOIN user_profiles up ON up."userId" = u.id
       WHERE 1=1 ${cc} ${rng('c."createdAt"', f)}
       ORDER BY c."createdAt" DESC LIMIT 100`,
      repl(f)
    ),
  ]);
  return { rows, unassigned: unassigned.n, recent };
}

// ─────────────────────────────────────────────────────────────
// Utilisateurs
// ─────────────────────────────────────────────────────────────

const USER_LAST_ACTIVITY = `GREATEST(
  (SELECT MAX(x."updatedAt") FROM projects x WHERE x."ownerId" = u.id),
  (SELECT MAX(x."createdAt") FROM project_activities x WHERE x."userId" = u.id),
  (SELECT MAX(x."createdAt") FROM project_actions x WHERE x."createdBy" = u.id),
  (SELECT MAX(x."createdAt") FROM commercial_contacts x WHERE x."createdBy" = u.id),
  (SELECT MAX(x."createdAt") FROM commercial_contact_actions x WHERE x."createdBy" = u.id),
  (SELECT MAX(x."createdAt") FROM commercial_contact_relances x WHERE x."createdBy" = u.id),
  (SELECT MAX(x."createdAt") FROM finance_documents x WHERE x."uploadedBy" = u.id),
  (SELECT MAX(x."createdAt") FROM por_promesh x WHERE x."createdBy" = u.id),
  (SELECT MAX(x."createdAt") FROM industrial_records x WHERE x."createdBy" = u.id),
  (SELECT MAX(x."createdAt") FROM recuperable_fiches x WHERE x."createdBy" = u.id),
  (SELECT MAX(x."approvedAt") FROM archive_requests x WHERE x."approvedBy" = u.id)
)`;

function userCounters(f) {
  const r = (col) => rng(col, f);
  return `
    (SELECT COUNT(*) FROM projects x WHERE x."ownerId" = u.id ${r('x."createdAt"')})::int AS "projectsCreated",
    (SELECT COUNT(DISTINCT x."projectId") FROM project_activities x WHERE x."userId" = u.id AND x.type IN ('edit','stage_change') ${r('x."createdAt"')})::int AS "projectsModified",
    (SELECT COUNT(DISTINCT x."projectId") FROM archive_requests x WHERE x."approvedBy" = u.id AND x.status = 'approved' AND x.type = 'ARCHIVAGE' ${r('x."approvedAt"')})::int AS "projectsArchived",
    (SELECT COUNT(*) FROM commercial_contacts x WHERE x."createdBy" = u.id ${r('x."createdAt"')})::int AS "contactsCreated",
    ((SELECT COUNT(*) FROM project_actions x WHERE x."createdBy" = u.id ${r('x."createdAt"')})
      + (SELECT COUNT(*) FROM commercial_contact_actions x WHERE x."createdBy" = u.id ${r('x."createdAt"')}))::int AS "actionsCreated",
    (SELECT COUNT(*) FROM commercial_contact_relances x WHERE x."createdBy" = u.id ${r('x."createdAt"')})::int AS "relancesCreated",
    (SELECT COUNT(*) FROM finance_documents x WHERE x."uploadedBy" = u.id ${r('x."createdAt"')})::int AS "documents",
    (SELECT COUNT(*) FROM por_promesh x WHERE x."createdBy" = u.id ${r('x."createdAt"')})::int AS "fichesPromesh",
    (SELECT COUNT(*) FROM industrial_records x WHERE x."createdBy" = u.id ${r('x."createdAt"')})::int AS "fichesIndustrial",
    (SELECT COUNT(*) FROM recuperable_fiches x WHERE x."createdBy" = u.id ${r('x."createdAt"')})::int AS "fichesRecuperable"`;
}

function finalizeUser(row) {
  const fiches = row.fichesPromesh + row.fichesIndustrial + row.fichesRecuperable;
  const total =
    row.projectsCreated + row.projectsModified + row.projectsArchived + row.contactsCreated +
    row.actionsCreated + row.relancesCreated + row.documents + fiches;
  return { ...row, fiches, lastActivityInPeriod: total > 0 };
}

async function users(f) {
  const rows = await run(
    `SELECT u.id, ${NAME("u", "up")} AS name, u.email, u.role, u."isActive", u."createdAt",
      ${userCounters(f)},
      ${USER_LAST_ACTIVITY} AS "lastActivityAt"
     FROM users u LEFT JOIN user_profiles up ON up."userId" = u.id
     ${f.userId ? "WHERE u.id = :userId" : ""}
     ORDER BY name ASC`,
    repl(f)
  );
  return rows.map(finalizeUser);
}

async function userDetail(id, f) {
  if (!UUID_RE.test(String(id))) throw badRequest("Invalid user id");
  const [row] = await run(
    `SELECT u.id, ${NAME("u", "up")} AS name, u.email, u.role, u."isActive", u."createdAt",
      up.phone, up.departement, up.service,
      ${userCounters(f)},
      ${USER_LAST_ACTIVITY} AS "lastActivityAt"
     FROM users u LEFT JOIN user_profiles up ON up."userId" = u.id WHERE u.id = :uid`,
    repl(f, { uid: id })
  );
  if (!row) return null;
  const events = await activity({ ...f, userId: id }, { limit: 30 });
  // Dernière connexion : uniquement lastLoginIp/browser/country existent — aucune date de connexion
  // n'est stockée sur users (mfaLastVerifiedAt = dernière vérification MFA).
  const [login] = await run(`SELECT "mfaLastVerifiedAt" FROM users WHERE id = :uid`, { uid: id });
  return { user: finalizeUser(row), lastMfaVerifiedAt: login?.mfaLastVerifiedAt || null, recent: events.rows };
}

// ─────────────────────────────────────────────────────────────
// Journal d'activité
// ─────────────────────────────────────────────────────────────

const EVENTS_CTE = `
WITH ev AS (
  SELECT p."createdAt" AS at, 'project_created' AS type, 'project' AS module, p.id::text AS ref,
         p."nomProjet" AS label, p."ownerId"::text AS uid, 'owner' AS src, p.statut::text AS status
    FROM projects p
  UNION ALL
  SELECT pa."createdAt", CASE pa.type WHEN 'edit' THEN 'project_modified' ELSE 'project_stage' END, 'project',
         pa."projectId"::text, p."nomProjet", pa."userId"::text, 'actor', NULL
    FROM project_activities pa JOIN projects p ON p.id = pa."projectId"
   WHERE pa.type IN ('edit','stage_change')
  UNION ALL
  SELECT ar."approvedAt", CASE ar.type WHEN 'ARCHIVAGE' THEN 'project_archived' ELSE 'project_unarchived' END, 'project',
         ar."projectId"::text, p."nomProjet", ar."approvedBy"::text, 'actor', NULL
    FROM archive_requests ar JOIN projects p ON p.id = ar."projectId"
   WHERE ar.status = 'approved' AND ar."approvedAt" IS NOT NULL
  UNION ALL
  SELECT c."createdAt", 'contact_created', 'contact', c.id::text,
         COALESCE(NULLIF(TRIM(c."nomSociete"),''), TRIM(CONCAT_WS(' ', c.prenom, c.nom))), c."createdBy"::text, 'actor', c.statut::text
    FROM commercial_contacts c
  UNION ALL
  SELECT x."createdAt", 'action_created', 'action', x.id::text, p."nomProjet", x."createdBy"::text, 'actor', x.statut::text
    FROM project_actions x JOIN projects p ON p.id = x."projectId"
  UNION ALL
  SELECT x."createdAt", 'action_created', 'action', x.id::text,
         COALESCE(NULLIF(TRIM(c."nomSociete"),''), TRIM(CONCAT_WS(' ', c.prenom, c.nom))), x."createdBy"::text, 'actor', x.statut::text
    FROM commercial_contact_actions x JOIN commercial_contacts c ON c.id = x."commercialContactId"
  UNION ALL
  SELECT x."createdAt", 'relance_created', 'relance', x.id::text,
         COALESCE(NULLIF(TRIM(c."nomSociete"),''), TRIM(CONCAT_WS(' ', c.prenom, c.nom))), x."createdBy"::text, 'actor', x."statutRelance"::text
    FROM commercial_contact_relances x JOIN commercial_contacts c ON c.id = x."commercialContactId"
  UNION ALL
  SELECT x."createdAt", 'fiche_created', 'fiche', x.id::text,
         'PROMESH ' || COALESCE(x."sequenceNumber"::text, '') || ' (' || COALESCE(x.machine::text, '') || ')',
         x."createdBy"::text, 'actor', x.status::text
    FROM por_promesh x
  UNION ALL
  SELECT x."createdAt", 'fiche_created', 'fiche', x.id::text,
         UPPER(x.module::text) || ' (' || COALESCE(x.machine::text, '') || ')', x."createdBy"::text, 'actor', x.statut::text
    FROM industrial_records x
  UNION ALL
  SELECT x."createdAt", 'fiche_created', 'fiche', x.id::text,
         UPPER(x.module::text) || ' REC (' || COALESCE(x.machine::text, '') || ')', x."createdBy"::text, 'actor', x.statut::text
    FROM recuperable_fiches x
)`;

async function activity(f, { limit = 100, offset = 0, module } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 5000);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  let cond = rng("ev.at", f);
  if (f.userId) cond += " AND ev.uid = :userId";
  if (f.commercialId) cond += " AND ev.uid = :commercialId";
  const mod = module && ["project", "contact", "action", "relance", "fiche"].includes(module) ? module : null;
  if (mod) cond += ` AND ev.module = '${mod}'`;

  const [rows, [{ total }]] = await Promise.all([
    run(
      `${EVENTS_CTE}
       SELECT ev.at, ev.type, ev.module, ev.ref, ev.label, ev.uid AS "userId", ev.src AS "actorSource", ev.status,
              ${NAME("u", "up")} AS "userName", u.role AS "userRole"
       FROM ev LEFT JOIN users u ON u.id::text = ev.uid LEFT JOIN user_profiles up ON up."userId" = u.id
       WHERE ev.at IS NOT NULL ${cond}
       ORDER BY ev.at DESC LIMIT :limit OFFSET :offset`,
      repl(f, { limit: lim, offset: off })
    ),
    run(`${EVENTS_CTE} SELECT COUNT(*)::int AS total FROM ev WHERE ev.at IS NOT NULL ${cond}`, repl(f)),
  ]);
  return { total, rows };
}

// ─────────────────────────────────────────────────────────────
// Industrie
// ─────────────────────────────────────────────────────────────

async function industrial(f) {
  const wantPromesh = f.module !== "probar";
  const wantProbar = f.module !== "promesh";
  const empty = Promise.resolve([]);

  const [
    pTotals, pDay, pShift, pMesh,
    bTotals, bDay, bShift,
    recModule, recDay, recDiameter, recShift,
  ] = await Promise.all([
    wantPromesh ? run(
      `SELECT COUNT(*)::int AS fiches, COALESCE(SUM(pp."productionM2"),0)::float8 AS quantity,
        SUM(pp."totalChuteBarres")::float8 AS "wasteBars", SUM(pp."totalDechetGraine")::float8 AS "wasteSeed",
        COUNT(DISTINCT ${MACHINE("pp.machine")})::int AS machines, MAX(pp."dateProduction") AS "lastAt"
       FROM por_promesh pp WHERE 1=1 ${promeshCond(f)}`, repl(f)) : empty,
    wantPromesh ? run(
      `SELECT to_char(pp."dateProduction",'YYYY-MM-DD') AS date, COUNT(*)::int AS fiches,
        COALESCE(SUM(pp."productionM2"),0)::float8 AS quantity,
        (CASE WHEN COUNT(pp."totalChuteBarres") + COUNT(pp."totalDechetGraine") = 0 THEN NULL
         ELSE COALESCE(SUM(pp."totalChuteBarres"),0) + COALESCE(SUM(pp."totalDechetGraine"),0) END)::float8 AS waste
       FROM por_promesh pp WHERE pp."dateProduction" IS NOT NULL ${promeshCond(f)} GROUP BY 1 ORDER BY 1`, repl(f)) : empty,
    wantPromesh ? run(
      `SELECT ${SHIFT("pp.poste")} AS shift, COUNT(*)::int AS fiches, COALESCE(SUM(pp."productionM2"),0)::float8 AS quantity
       FROM por_promesh pp WHERE 1=1 ${promeshCond(f)} GROUP BY 1 ORDER BY fiches DESC`, repl(f)) : empty,
    wantPromesh ? run(
      `SELECT COALESCE(NULLIF(TRIM(pp."diametreMaille1"::text),''),'unknown') AS diameter, COUNT(*)::int AS fiches,
        COALESCE(SUM(pp."productionM2"),0)::float8 AS quantity
       FROM por_promesh pp WHERE 1=1 ${promeshCond(f)} GROUP BY 1 ORDER BY quantity DESC`, repl(f)) : empty,
    wantProbar ? run(
      `SELECT COUNT(*)::int AS fiches, COALESCE(SUM(ir."quantiteProduite"),0)::float8 AS quantity,
        COUNT(DISTINCT ${MACHINE("ir.machine")})::int AS machines, MAX(ir."dateFiche") AS "lastAt"
       FROM industrial_records ir WHERE 1=1 ${probarCond(f)}`, repl(f)) : empty,
    wantProbar ? run(
      `SELECT to_char(ir."dateFiche",'YYYY-MM-DD') AS date, COUNT(*)::int AS fiches,
        COALESCE(SUM(ir."quantiteProduite"),0)::float8 AS quantity
       FROM industrial_records ir WHERE ir."dateFiche" IS NOT NULL ${probarCond(f)} GROUP BY 1 ORDER BY 1`, repl(f)) : empty,
    wantProbar ? run(
      `SELECT ${SHIFT("ir.poste")} AS shift, COUNT(*)::int AS fiches, COALESCE(SUM(ir."quantiteProduite"),0)::float8 AS quantity
       FROM industrial_records ir WHERE 1=1 ${probarCond(f)} GROUP BY 1 ORDER BY fiches DESC`, repl(f)) : empty,
    run(
      `SELECT UPPER(rf.module::text) AS module, COUNT(*)::int AS fiches, COALESCE(SUM(rf.waste),0)::float8 AS waste,
        COALESCE(SUM(rf."wasteFinishedProduct"),0)::float8 AS "wasteFinishedProduct", MAX(rf."date") AS "lastAt"
       FROM recuperable_fiches rf WHERE 1=1 ${recupCond(f)} GROUP BY 1`, repl(f)),
    run(
      `SELECT to_char(rf."date",'YYYY-MM-DD') AS date, UPPER(rf.module::text) AS module, COALESCE(SUM(rf.waste),0)::float8 AS waste
       FROM recuperable_fiches rf WHERE rf."date" IS NOT NULL ${recupCond(f)} GROUP BY 1, 2 ORDER BY 1`, repl(f)),
    run(
      `SELECT COALESCE(NULLIF(TRIM(rl.diametre::text),''),'unknown') AS diameter, COALESCE(SUM(rl."dechetKg"),0)::float8 AS waste
       FROM recuperable_lignes rl JOIN recuperable_fiches rf ON rf.id = rl."ficheId"
       WHERE 1=1 ${recupCond(f)} GROUP BY 1 ORDER BY waste DESC`, repl(f)),
    run(
      `SELECT ${SHIFT("rf.poste")} AS shift, UPPER(rf.module::text) AS module, COUNT(*)::int AS fiches
       FROM recuperable_fiches rf WHERE 1=1 ${recupCond(f)} GROUP BY 1, 2`, repl(f)),
  ]);

  const probarWasteByDay = new Map(recDay.filter((r) => r.module === "PROBAR").map((r) => [r.date, r.waste]));
  const probarDates = new Set([...bDay.map((d) => d.date), ...probarWasteByDay.keys()]);
  const bDayMap = new Map(bDay.map((d) => [d.date, d]));
  const probarPerDay = [...probarDates].sort().map((date) => ({
    date,
    fiches: bDayMap.get(date)?.fiches || 0,
    quantity: bDayMap.get(date)?.quantity || 0,
    waste: probarWasteByDay.get(date) ?? null,
  }));

  const recModuleMap = Object.fromEntries(recModule.map((r) => [r.module, r]));

  return {
    promesh: wantPromesh ? {
      totals: pTotals[0], perDay: pDay, perShift: pShift, perDiameter: pMesh,
    } : null,
    probar: wantProbar ? {
      totals: { ...bTotals[0], waste: recModuleMap.PROBAR?.waste ?? null, wasteSheets: recModuleMap.PROBAR?.fiches ?? 0 },
      perDay: probarPerDay, perShift: bShift,
    } : null,
    recuperables: { perModule: recModule, perDiameter: recDiameter, perShift: recShift },
  };
}

async function machines(f, { runsLimit = 200 } = {}) {
  const wantPromesh = f.module !== "probar";
  const wantProbar = f.module !== "promesh";
  const empty = Promise.resolve([]);
  const lim = Math.min(Math.max(parseInt(runsLimit, 10) || 200, 1), 5000);

  const stopCond = `(NULLIF(TRIM(a."tArret"),'') IS NOT NULL OR NULLIF(TRIM(a."observationMachine"),'') IS NOT NULL)`;

  const [pm, pms, bm, bms, rec, stopCounts, stopList, maint, maintList, maintReq, runs] = await Promise.all([
    wantPromesh ? run(
      `SELECT ${MACHINE("pp.machine")} AS machine, COUNT(*)::int AS fiches, COALESCE(SUM(pp."productionM2"),0)::float8 AS quantity,
        SUM(pp."totalChuteBarres")::float8 AS "wasteBars", SUM(pp."totalDechetGraine")::float8 AS "wasteSeed",
        MIN(pp."dateProduction") AS "firstAt", MAX(pp."dateProduction") AS "lastAt"
       FROM por_promesh pp WHERE 1=1 ${promeshCond(f)} GROUP BY 1 ORDER BY 1`, repl(f)) : empty,
    wantPromesh ? run(
      `SELECT ${MACHINE("pp.machine")} AS machine, ${SHIFT("pp.poste")} AS shift, COUNT(*)::int AS fiches, COALESCE(SUM(pp."productionM2"),0)::float8 AS quantity
       FROM por_promesh pp WHERE 1=1 ${promeshCond(f)} GROUP BY 1, 2`, repl(f)) : empty,
    wantProbar ? run(
      `SELECT ${MACHINE("ir.machine")} AS machine, COUNT(*)::int AS fiches, COALESCE(SUM(ir."quantiteProduite"),0)::float8 AS quantity,
        MIN(ir."dateFiche") AS "firstAt", MAX(ir."dateFiche") AS "lastAt"
       FROM industrial_records ir WHERE 1=1 ${probarCond(f)} GROUP BY 1 ORDER BY 1`, repl(f)) : empty,
    wantProbar ? run(
      `SELECT ${MACHINE("ir.machine")} AS machine, ${SHIFT("ir.poste")} AS shift, COUNT(*)::int AS fiches, COALESCE(SUM(ir."quantiteProduite"),0)::float8 AS quantity
       FROM industrial_records ir WHERE 1=1 ${probarCond(f)} GROUP BY 1, 2`, repl(f)) : empty,
    run(
      `SELECT UPPER(rf.module::text) AS module, ${MACHINE("rf.machine")} AS machine, COUNT(*)::int AS fiches,
        COALESCE(SUM(rf.waste),0)::float8 AS waste
       FROM recuperable_fiches rf WHERE 1=1 ${recupCond(f)} GROUP BY 1, 2`, repl(f)),
    wantPromesh ? run(
      `SELECT ${MACHINE("pp.machine")} AS machine, COUNT(a.id)::int AS stoppages
       FROM por_promesh_arrets_machine a JOIN por_promesh pp ON pp.id = a."porPromeshId"
       WHERE ${stopCond} ${promeshCond(f)} GROUP BY 1`, repl(f)) : empty,
    wantPromesh ? run(
      `SELECT to_char(pp."dateProduction",'YYYY-MM-DD') AS date, ${MACHINE("pp.machine")} AS machine, ${SHIFT("pp.poste")} AS shift,
        a."tArret" AS "stopValue", a."observationMachine" AS observation, pp.id AS "ficheId"
       FROM por_promesh_arrets_machine a JOIN por_promesh pp ON pp.id = a."porPromeshId"
       WHERE ${stopCond} ${promeshCond(f)} ORDER BY pp."dateProduction" DESC NULLS LAST LIMIT 200`, repl(f)) : empty,
    run(
      `SELECT ${MACHINE("ir.machine")} AS machine, COUNT(*)::int AS fiches
       FROM industrial_records ir WHERE ir.module = 'maintenance' ${rng('ir."dateFiche"', f)} ${f.machine ? " AND ir.machine = :machine" : ""}
       GROUP BY 1`, repl(f)),
    run(
      `SELECT to_char(ir."dateFiche",'YYYY-MM-DD') AS date, ${MACHINE("ir.machine")} AS machine, ir."typePanne" AS "faultType",
        ir.urgence AS urgency, ir.description, ir.statut AS status
       FROM industrial_records ir WHERE ir.module = 'maintenance' ${rng('ir."dateFiche"', f)} ${f.machine ? " AND ir.machine = :machine" : ""}
       ORDER BY ir."dateFiche" DESC NULLS LAST LIMIT 100`, repl(f)),
    run(
      `SELECT mr."ticketNo", mr.equipement AS equipment, mr."typePanne" AS "faultType", mr.urgence AS urgency, mr.statut AS status,
        mr."createdAt"
       FROM maintenance_requests mr WHERE 1=1 ${rng('mr."createdAt"', f)}
       ORDER BY mr."createdAt" DESC LIMIT 100`, repl(f)),
    run(
      `SELECT * FROM (
         SELECT to_char(pp."dateProduction",'YYYY-MM-DD') AS date, 'PROMESH' AS module, ${MACHINE("pp.machine")} AS machine, ${SHIFT("pp.poste")} AS shift,
           pp."productionM2"::float8 AS quantity,
           (CASE WHEN pp."totalChuteBarres" IS NULL AND pp."totalDechetGraine" IS NULL THEN NULL
         ELSE COALESCE(pp."totalChuteBarres",0) + COALESCE(pp."totalDechetGraine",0) END)::float8 AS waste,
           pp."heureDebut"::text AS "startTime", pp."heureFin"::text AS "endTime", pp.status::text AS status, pp.operateur AS operator,
           (SELECT COUNT(*) FROM por_promesh_arrets_machine a WHERE a."porPromeshId" = pp.id AND ${stopCond})::int AS stoppages,
           pp."dateProduction" AS sort_at
         FROM por_promesh pp WHERE 1=1 ${wantPromesh ? promeshCond(f) : " AND false"}
         UNION ALL
         SELECT to_char(ir."dateFiche",'YYYY-MM-DD'), 'PROBAR', ${MACHINE("ir.machine")}, ${SHIFT("ir.poste")},
           ir."quantiteProduite"::float8, NULL, ir."heureDebut"::text, ir."heureFin"::text, ir.statut::text, ir.operateur, NULL,
           ir."dateFiche"
         FROM industrial_records ir WHERE 1=1 ${wantProbar ? probarCond(f) : " AND false"}
       ) t ORDER BY sort_at DESC NULLS LAST LIMIT :limit`,
      repl(f, { limit: lim })),
  ]);

  const shiftMap = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const cur = m.get(r.machine) || {};
      cur[r.shift] = r.fiches;
      m.set(r.machine, cur);
    }
    return m;
  };
  const pShift = shiftMap(pms);
  const bShift = shiftMap(bms);
  const qtyMap = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const cur = m.get(r.machine) || {};
      cur[r.shift] = r.quantity;
      m.set(r.machine, cur);
    }
    return m;
  };
  const pQty = qtyMap(pms);
  const bQty = qtyMap(bms);
  const alias = (r, qty) => ({
    productionRecords: r.fiches,
    totalQuantity: r.quantity,
    totalWaste: r.waste,
    morningQuantity: qty?.matin ?? 0,
    eveningQuantity: qty?.soir ?? 0,
    nightQuantity: qty?.nuit ?? 0,
    lastProduction: r.lastAt,
  });
  const stopMap = new Map(stopCounts.map((r) => [r.machine, r.stoppages]));
  const maintMap = new Map(maint.map((r) => [r.machine, r.fiches]));
  const recMap = (mod) => new Map(rec.filter((r) => r.module === mod).map((r) => [r.machine, r]));
  const recP = recMap("PROMESH");
  const recB = recMap("PROBAR");

  const rows = [
    ...pm.map((r) => ({
      module: "PROMESH", ...r, ...alias({ ...r, waste: r.wasteBars == null && r.wasteSeed == null ? null : (r.wasteBars || 0) + (r.wasteSeed || 0) }, pQty.get(r.machine)), waste: r.wasteBars == null && r.wasteSeed == null ? null : (r.wasteBars || 0) + (r.wasteSeed || 0),
      shifts: pShift.get(r.machine) || {}, stoppages: stopMap.get(r.machine) ?? 0,
      maintenanceSheets: maintMap.get(r.machine) ?? 0,
      recuperableSheets: recP.get(r.machine)?.fiches ?? 0, recuperableWaste: recP.get(r.machine)?.waste ?? null,
    })),
    ...bm.map((r) => ({
      module: "PROBAR", ...r, ...alias({ ...r, waste: recB.get(r.machine)?.waste ?? null }, bQty.get(r.machine)), wasteBars: null, wasteSeed: null, waste: recB.get(r.machine)?.waste ?? null,
      shifts: bShift.get(r.machine) || {}, stoppages: null,
      maintenanceSheets: maintMap.get(r.machine) ?? 0,
      recuperableSheets: recB.get(r.machine)?.fiches ?? 0, recuperableWaste: recB.get(r.machine)?.waste ?? null,
    })),
  ];

  return { machines: rows, stoppages: stopList, maintenanceSheets: maintList, maintenanceRequests: maintReq, runs };
}


// ─────────────────────────────────────────────────────────────
// PROD 1 / PROD 2 — lignes de production (machine "1" et "2")
// Aucune table ni modèle "PROD" n'existe : PROD n = fiches dont la machine
// vaut "n" dans por_promesh, industrial_records (module probar) et
// recuperable_fiches. La date de création est createdAt ; l'auteur createdBy.
// ─────────────────────────────────────────────────────────────

const PROD_KEYS = ["1", "2"];
const TZ = "Africa/Tunis";

const FICHES_CTE = `
WITH fi AS (
  SELECT 'promesh'::text AS type, 'promesh'::text AS mod, NULLIF(TRIM(pp.machine),'') AS machine, pp."createdBy" AS uid,
         pp."createdAt" AS at, pp.id::text AS ref, 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, '') AS label
    FROM por_promesh pp
  UNION ALL
  SELECT 'probar', 'probar', NULLIF(TRIM(ir.machine),''), ir."createdBy", ir."createdAt", ir.id::text, 'PROBAR'
    FROM industrial_records ir WHERE ir.module = 'probar'
  UNION ALL
  SELECT 'recuperable', LOWER(rf.module::text), NULLIF(TRIM(rf.machine),''), rf."createdBy", rf."createdAt", rf.id::text, 'REC ' || rf.module::text
    FROM recuperable_fiches rf
)`;

const dayKey = `to_char((fi.at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD')`;

function prodCond(f) {
  return (
    " AND fi.machine IN ('1','2')" +
    rng("fi.at", f) +
    (f.machine ? " AND fi.machine = :machine" : "") +
    (f.userId ? " AND fi.uid = :userId" : "") +
    (f.module ? ` AND fi.mod = '${f.module}'` : "")
  );
}

function periodDays(f) {
  if (!f.from || !f.toEx) return null;
  const days = [];
  let d = dayjs(f.from).startOf("day");
  const end = dayjs(f.toEx).startOf("day");
  while (d.isBefore(end) && days.length < 400) {
    days.push(d.format("YYYY-MM-DD"));
    d = d.add(1, "day");
  }
  return days;
}

async function production(f) {
  const cond = prodCond(f);
  const [totals, perDay, perUser, last] = await Promise.all([
    run(
      `${FICHES_CTE}
       SELECT fi.machine, COUNT(*)::int AS total, MIN(fi.at) AS "firstAt", MAX(fi.at) AS "lastAt",
        COUNT(*) FILTER (WHERE fi.type = 'promesh')::int AS promesh,
        COUNT(*) FILTER (WHERE fi.type = 'probar')::int AS probar,
        COUNT(*) FILTER (WHERE fi.type = 'recuperable')::int AS recuperable,
        COUNT(*) FILTER (WHERE u.id IS NULL)::int AS "missingUser",
        COUNT(*) FILTER (WHERE fi.at IS NULL)::int AS "missingDate"
       FROM fi LEFT JOIN users u ON u.id = fi.uid
       WHERE 1=1 ${cond} GROUP BY fi.machine`, repl(f)),
    run(
      `${FICHES_CTE}
       SELECT fi.machine, ${dayKey} AS day, COUNT(*)::int AS n
       FROM fi WHERE fi.at IS NOT NULL ${cond} GROUP BY 1, 2 ORDER BY 2`, repl(f)),
    run(
      `${FICHES_CTE}
       SELECT fi.machine, fi.uid::text AS "userId", ${NAME("u", "up")} AS name, u.email AS email, COUNT(*)::int AS fiches,
        MIN(fi.at) AS "firstAt", MAX(fi.at) AS "lastAt"
       FROM fi LEFT JOIN users u ON u.id = fi.uid LEFT JOIN user_profiles up ON up."userId" = u.id
       WHERE 1=1 ${cond} GROUP BY fi.machine, fi.uid, u.email, up.name, up.prenom, up.nom
       ORDER BY fiches DESC, name ASC`, repl(f)),
    run(
      `${FICHES_CTE}
       SELECT DISTINCT ON (fi.machine) fi.machine, fi.at, fi.type, fi.ref, fi.label, fi.uid::text AS "userId", ${NAME("u", "up")} AS "userName"
       FROM fi LEFT JOIN users u ON u.id = fi.uid LEFT JOIN user_profiles up ON up."userId" = u.id
       WHERE fi.at IS NOT NULL ${cond} ORDER BY fi.machine, fi.at DESC`, repl(f)),
  ]);

  const days = periodDays(f);
  const lines = PROD_KEYS.map((k) => {
    const tt = totals.find((x) => x.machine === k) || { total: 0, promesh: 0, probar: 0, recuperable: 0, missingUser: 0, missingDate: 0, firstAt: null, lastAt: null };
    const dayMap = new Map(perDay.filter((x) => x.machine === k).map((x) => [x.day, x.n]));
    const perDayRows = (days || [...dayMap.keys()].sort()).map((d) => ({ date: d, count: dayMap.get(d) || 0 }));
    const lst = last.find((x) => x.machine === k) || null;
    return {
      key: k,
      name: `PROD ${k}`,
      total: tt.total,
      firstAt: tt.firstAt,
      lastAt: tt.lastAt,
      byType: { promesh: tt.promesh, probar: tt.probar, recuperable: tt.recuperable },
      missingUser: tt.missingUser,
      missingDate: tt.missingDate,
      daysWithSheets: dayMap.size,
      daysInPeriod: days ? days.length : null,
      daysWithoutSheets: days ? days.length - dayMap.size : null,
      perDay: perDayRows,
      perUser: perUser.filter((x) => x.machine === k).map(({ machine, ...r }) => r),
      last: lst && { at: lst.at, type: lst.type, ref: lst.ref, label: lst.label, userId: lst.userId, userName: lst.userName },
    };
  });

  const allDates = days || [...new Set(perDay.map((x) => x.day))].sort();
  const daily = allDates.map((d) => {
    const p1 = lines[0].perDay.find((x) => x.date === d)?.count || 0;
    const p2 = lines[1].perDay.find((x) => x.date === d)?.count || 0;
    return { date: d, prod1: p1, prod2: p2, total: p1 + p2 };
  });

  const umap = new Map();
  for (const l of lines) {
    for (const u of l.perUser) {
      const key = u.userId || "none";
      const cur = umap.get(key) || { userId: u.userId, name: u.name, email: u.email, prod1: 0, prod2: 0, total: 0, firstAt: null, lastAt: null };
      cur[`prod${l.key}`] += u.fiches;
      cur.total += u.fiches;
      if (u.firstAt && (!cur.firstAt || u.firstAt < cur.firstAt)) cur.firstAt = u.firstAt;
      if (u.lastAt && (!cur.lastAt || u.lastAt > cur.lastAt)) cur.lastAt = u.lastAt;
      umap.set(key, cur);
    }
  }
  const users = [...umap.values()].sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));

  return {
    lines,
    daily,
    users,
    totals: { total: lines.reduce((s, l) => s + l.total, 0) },
    definition: { machineKeys: PROD_KEYS, dateField: "createdAt", sources: ["por_promesh", "industrial_records(module=probar)", "recuperable_fiches"] },
  };
}

function prodRemarks(p, f, t) {
  const out = [];
  for (const l of p.lines) {
    if (l.total === 0) {
      out.push({ code: "prodNone", kind: "recorded", count: 0, text: t("rProdNone", { name: l.name }) });
      continue;
    }
    out.push({ code: "prodCount", kind: "recorded", count: l.total, text: t("rProdCount", { name: l.name, n: l.total, users: l.perUser.length }) });
    if (l.daysInPeriod != null && l.daysWithoutSheets > 0)
      out.push({ code: "prodEmptyDays", kind: "recorded", count: l.daysWithoutSheets, text: t("rProdEmptyDays", { name: l.name, k: l.daysWithoutSheets, d: l.daysInPeriod }) });
    const top = l.perUser[0];
    if (top && l.perUser.length > 1 && top.name)
      out.push({ code: "prodTopUser", kind: "recorded", count: top.fiches, text: t("rProdTopUser", { name: l.name, user: top.name, n: top.fiches, total: l.total, pct: String(Math.round((top.fiches / l.total) * 1000) / 10).replace(f.lang === "fr" ? "." : ",", f.lang === "fr" ? "," : ".") }) });
    if (l.missingUser > 0) out.push({ code: "prodNoUser", kind: "recorded", count: l.missingUser, text: t("rProdNoUser", { name: l.name, n: l.missingUser }) });
    if (l.missingDate > 0) out.push({ code: "prodNoDate", kind: "recorded", count: l.missingDate, text: t("rProdNoDate", { name: l.name, n: l.missingDate }) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Qualité des données
// ─────────────────────────────────────────────────────────────

async function dataQuality(f) {
  const t = makeT(f.lang);
  const pc = projCond(f);
  const pr = rng('p."createdAt"', f);
  const cr = rng('c."createdAt"', f);
  const ppr = promeshCond(f);
  const ibr = probarCond(f);
  const notSpec = (col) => `${col}::text ILIKE '%not specified%'`;

  const checks = [
    { code: "projectsNoOwner", label: "qProjectsNoOwner", impact: "qImpactStats",
      sql: `SELECT p."nomProjet" AS label FROM projects p WHERE p."ownerId" IS NULL ${pc} ${pr}` },
    { code: "projectsNoClient", label: "qProjectsNoClient", impact: "qImpactStats",
      sql: `SELECT p."nomProjet" FROM projects p WHERE p."companyId" IS NULL AND NULLIF(TRIM(p.entreprise),'') IS NULL ${pc} ${pr}` },
    { code: "projectsNoStatus", label: "qProjectsNoStatus", impact: "qImpactGeneric",
      sql: `SELECT p."nomProjet" FROM projects p WHERE NULLIF(TRIM(p.statut),'') IS NULL AND p."pipelineStageId" IS NULL ${pc} ${pr}` },
    { code: "archivedNoReason", label: "qArchivedNoReason", impact: "qImpactTrace",
      sql: `SELECT p."nomProjet" FROM projects p WHERE p."isArchived" = true AND NULLIF(TRIM(p."archiveReason"),'') IS NULL ${pc} ${pr}` },
    { code: "archivedNoDate", label: "qArchivedNoDate", impact: "qImpactTrace",
      sql: `SELECT p."nomProjet" FROM projects p WHERE p."isArchived" = true AND p."archivedAt" IS NULL ${pc} ${pr}` },
    { code: "archivedNoUser", label: "qArchivedNoUser", impact: "qImpactTrace",
      sql: `SELECT p."nomProjet" FROM projects p WHERE p."isArchived" = true ${pc} ${pr}
             AND NOT EXISTS (SELECT 1 FROM archive_requests ar WHERE ar."projectId" = p.id AND ar.type = 'ARCHIVAGE' AND ar.status = 'approved' AND ar."approvedBy" IS NOT NULL)` },
    { code: "contactsNoCommercial", label: "qContactsNoCommercial", impact: "qImpactStats",
      sql: `SELECT COALESCE(NULLIF(TRIM(c."nomSociete"),''), TRIM(CONCAT_WS(' ', c.prenom, c.nom))) FROM commercial_contacts c
             WHERE c."commercialId" IS NULL ${contactCond(f)} ${cr}` },
    { code: "productionNoMachine", label: "qProductionNoMachine", impact: "qImpactProd",
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp WHERE NULLIF(TRIM(pp.machine),'') IS NULL ${ppr}
            UNION ALL SELECT 'PROBAR ' || ir.id::text FROM industrial_records ir WHERE NULLIF(TRIM(ir.machine),'') IS NULL ${ibr}` },
    { code: "productionNoShift", label: "qProductionNoShift", impact: "qImpactProd",
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp WHERE NULLIF(TRIM(pp.poste::text),'') IS NULL ${ppr}
            UNION ALL SELECT 'PROBAR ' || ir.id::text FROM industrial_records ir WHERE NULLIF(TRIM(ir.poste::text),'') IS NULL ${ibr}` },
    { code: "productionNoQuantity", label: "qProductionNoQuantity", impact: "qImpactProd",
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp WHERE COALESCE(pp."productionM2",0) = 0 ${ppr}
            UNION ALL SELECT 'PROBAR ' || ir.id::text FROM industrial_records ir WHERE COALESCE(ir."quantiteProduite",0) = 0 ${ibr}` },
    { code: "productionIncomplete", label: "qProductionIncomplete", impact: "qImpactProd", hidden: true,
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp
             WHERE (NULLIF(TRIM(pp.machine),'') IS NULL OR NULLIF(TRIM(pp.poste::text),'') IS NULL OR COALESCE(pp."productionM2",0) = 0) ${ppr}
            UNION ALL SELECT 'PROBAR ' || ir.id::text FROM industrial_records ir
             WHERE (NULLIF(TRIM(ir.machine),'') IS NULL OR NULLIF(TRIM(ir.poste::text),'') IS NULL OR COALESCE(ir."quantiteProduite",0) = 0) ${ibr}` },
    { code: "productionNoOperator", label: "qProductionNoOperator", impact: "qImpactGeneric",
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp WHERE NULLIF(TRIM(pp.operateur),'') IS NULL ${ppr}` },
    { code: "notSpecified", label: "qNotSpecified", impact: "qImpactGeneric",
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp
             WHERE (${notSpec("pp.machine")} OR ${notSpec("pp.poste")} OR ${notSpec("pp.operateur")}) ${ppr}
            UNION ALL SELECT 'PROBAR ' || ir.id::text FROM industrial_records ir
             WHERE (${notSpec("ir.machine")} OR ${notSpec("ir.poste")} OR ${notSpec("ir.operateur")}) ${ibr}
            UNION ALL SELECT 'REC ' || rf.id::text FROM recuperable_fiches rf
             WHERE (${notSpec("rf.machine")} OR ${notSpec("rf.poste")} OR ${notSpec("rf.operateur")}) ${recupCond(f)}
            UNION ALL SELECT p."nomProjet" FROM projects p WHERE (${notSpec("p.statut")} OR ${notSpec("p.user_nom")}) ${pc} ${pr}` },
    { code: "productionNoDate", label: "qProductionNoDate", impact: "qImpactProd",
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp WHERE pp."dateProduction" IS NULL ${rng('pp."createdAt"', f)}
            UNION ALL SELECT 'PROBAR ' || ir.id::text FROM industrial_records ir WHERE ir.module = 'probar' AND ir."dateFiche" IS NULL ${rng('ir."createdAt"', f)}` },
    { code: "contactsIncomplete", label: "qContactsIncomplete", impact: "qImpactStats",
      sql: `SELECT COALESCE(NULLIF(TRIM(c."nomSociete"),''), NULLIF(TRIM(CONCAT_WS(' ', c.prenom, c.nom)),''), c.id::text) FROM commercial_contacts c
             WHERE (NULLIF(TRIM(c.telephone),'') IS NULL OR (NULLIF(TRIM(c."nomSociete"),'') IS NULL AND NULLIF(TRIM(c.nom),'') IS NULL)) ${contactCond(f)} ${cr}` },
    { code: "usersNoActivity", label: "qUsersNoActivity", impact: "qImpactStats",
      sql: `SELECT ${NAME("u", "up")} FROM users u LEFT JOIN user_profiles up ON up."userId" = u.id
             WHERE u."isActive" = true AND ${USER_LAST_ACTIVITY} IS NULL` },
    { code: "sheetsNoUser", label: "qSheetsNoUser", impact: "qImpactTrace",
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp LEFT JOIN users u ON u.id = pp."createdBy" WHERE u.id IS NULL ${rng('pp."createdAt"', f)}
            UNION ALL SELECT 'PROBAR ' || ir.id::text FROM industrial_records ir LEFT JOIN users u ON u.id = ir."createdBy" WHERE u.id IS NULL ${rng('ir."createdAt"', f)}
            UNION ALL SELECT 'REC ' || rf.id::text FROM recuperable_fiches rf LEFT JOIN users u ON u.id = rf."createdBy" WHERE u.id IS NULL ${rng('rf."createdAt"', f)}` },
    { code: "dupProjects", label: "qDupProjects", impact: "qImpactDup",
      sql: `SELECT MIN(p."nomProjet") || ' (x' || COUNT(*) || ')' FROM projects p WHERE 1=1 ${pc} ${pr}
            GROUP BY LOWER(TRIM(p."nomProjet")) HAVING COUNT(*) > 1` },
    { code: "dupContacts", label: "qDupContacts", impact: "qImpactDup",
      sql: `SELECT MIN(COALESCE(NULLIF(TRIM(c."nomSociete"),''), c.nom)) || ' (x' || COUNT(*) || ')' FROM commercial_contacts c
             WHERE NULLIF(TRIM(c.telephone),'') IS NOT NULL AND NULLIF(TRIM(c."nomSociete"),'') IS NOT NULL ${contactCond(f)} ${cr}
             GROUP BY LOWER(TRIM(c."nomSociete")), TRIM(c.telephone) HAVING COUNT(*) > 1` },
    { code: "dupProduction", label: "qDupProduction", impact: "qImpactDup",
      sql: `SELECT to_char(pp."dateProduction",'YYYY-MM-DD') || ' / ' || COALESCE(pp.machine,'?') || ' / ' || COALESCE(pp.poste::text,'?') || ' (x' || COUNT(*) || ')'
             FROM por_promesh pp WHERE pp."dateProduction" IS NOT NULL ${ppr}
             GROUP BY pp."dateProduction", pp.machine, pp.poste HAVING COUNT(*) > 1` },
    { code: "closedNoDate", label: "qClosedNoDate", impact: "qImpactGeneric",
      sql: `SELECT 'REC ' || rf.id::text FROM recuperable_fiches rf WHERE rf.statut = 'cloturee' AND rf."dateCloture" IS NULL ${recupCond(f)}` },
    { code: "validatedNoDate", label: "qValidatedNoDate", impact: "qImpactGeneric",
      sql: `SELECT 'PROMESH #' || COALESCE(pp."sequenceNumber"::text, pp.id::text) FROM por_promesh pp
             WHERE pp.status = 'VALIDE' AND pp."validatedAt" IS NULL ${ppr}` },
  ];

  const results = await Promise.all(
    checks.map(async (c) => {
      const [r] = await run(
        `SELECT COUNT(*)::int AS n, (ARRAY_AGG(label::text))[1:3] AS ex FROM (${c.sql}) q(label)`,
        repl(f)
      );
      return {
        code: c.code,
        hidden: !!c.hidden,
        type: c.label,
        label: t(c.label),
        impactKey: c.impact,
        impact: t(c.impact),
        count: r.n,
        examples: (r.ex || []).filter(Boolean),
      };
    })
  );
  return { disclaimerKey: "qDisclaimer", disclaimer: t("qDisclaimer"), checks: results };
}

// ─────────────────────────────────────────────────────────────
// Remarques + recommandations (dérivées uniquement des données)
// ─────────────────────────────────────────────────────────────

async function insights(f, prefetched = {}) {
  const t = makeT(f.lang);
  const [usersRows, quality, mach, prod] = await Promise.all([
    prefetched.users || users(f),
    prefetched.quality || dataQuality(f),
    prefetched.machines || machines(f, { runsLimit: 1 }),
    prefetched.production || production(f),
  ]);
  const qmap = Object.fromEntries(quality.checks.map((c) => [c.code, c]));

  const pc = projCond(f);
  let inactive = null;
  if (f.from) {
    const [r] = await run(
      `SELECT COUNT(*)::int AS n FROM projects p LEFT JOIN LATERAL (
         SELECT MAX(x."createdAt") AS m FROM project_activities x WHERE x."projectId" = p.id) a ON true
       LEFT JOIN LATERAL (SELECT MAX(x."createdAt") AS m FROM project_actions x WHERE x."projectId" = p.id) b ON true
       WHERE p."isArchived" = false ${pc}
         AND GREATEST(p."updatedAt", a.m, b.m) < :from`,
      repl(f)
    );
    inactive = r.n;
  }
  const [arch] = await run(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE 1=1 ${rng('p."archivedAt"', f)})::int AS "inPeriod"
     FROM projects p WHERE p."isArchived" = true ${pc}`,
    repl(f)
  );
  const noActivityUsers = usersRows.filter((u) => u.isActive && !u.lastActivityInPeriod).length;
  const stopMachines = mach.machines.filter((m) => m.stoppages > 0);

  const remarks = [];
  const incomplete = qmap.productionIncomplete?.count || 0;
  if (incomplete > 0)
    remarks.push({ code: "incompleteProduction", kind: "interpretation", count: incomplete, text: t("rIncompleteProduction", { n: incomplete }) });
  if (inactive > 0)
    remarks.push({ code: "projectsNoRecentActivity", kind: "interpretation", count: inactive, text: t("rProjectsNoRecentActivity", { n: inactive }) });
  if (arch.total > 0)
    remarks.push({ code: "archivedProjects", kind: "recorded", count: arch.total, text: t("rArchivedProjects", { n: arch.total, m: arch.inPeriod }) });
  const archNoUser = qmap.archivedNoUser?.count || 0;
  if (archNoUser > 0)
    remarks.push({ code: "archiveTraceMissing", kind: "recorded", count: archNoUser, text: t("rArchiveTraceMissing", { n: archNoUser }) });
  if (stopMachines.length > 0) {
    const list = stopMachines.map((m) => `${m.module} ${m.machine} (${m.stoppages})`).join(", ");
    remarks.push({ code: "machinesStoppages", kind: "recorded", count: stopMachines.length, text: t("rMachinesStoppages", { list }) });
  }
  if (noActivityUsers > 0)
    remarks.push({ code: "usersNoActivity", kind: "recorded", count: noActivityUsers, text: t("rUsersNoActivity", { n: noActivityUsers }) });

  remarks.push(...prodRemarks(prod, f, t));

  const recommendations = [];
  const rec = (code, data, n, extra = {}) =>
    recommendations.push({
      code,
      finding: t(`${code}Finding`, { n, ...extra }),
      data,
      dataText: Object.entries(data).map(([k, v]) => `${t(k)}: ${v}`).join(", "),
      impact: t(`${code}Impact`),
      recommendation: t(`${code}Reco`),
    });

  if (inactive > 0) rec("recNoActivity", { dProjects: inactive }, inactive);
  const noComm = qmap.contactsNoCommercial?.count || 0;
  if (noComm > 0) rec("recContacts", { dContacts: noComm }, noComm);
  const visible = quality.checks.filter((c) => !c.hidden && !c.code.startsWith("dup") && c.code !== "usersNoActivity" && c.count > 0);
  const dupP = qmap.dupProjects?.count || 0;
  const dupF = qmap.dupProduction?.count || 0;
  if (dupP + dupF > 0)
    remarks.push({ code: "duplicates", kind: "interpretation", count: dupP + dupF, text: t("rDuplicates", { n: dupP, m: dupF }) });
  if (visible.length > 0) {
    rec("recIncomplete", { dAnomalyTypes: visible.length }, visible.length, {
      total: visible.reduce((s, c) => s + c.count, 0),
    });
  }
  const prodNoUser = prod.lines.reduce((x, l) => x + l.missingUser, 0);
  if (prodNoUser > 0) rec("recProdNoUser", { dRecords: prodNoUser }, prodNoUser);
  const prodNoDate = prod.lines.reduce((x, l) => x + l.missingDate, 0);
  if (prodNoDate > 0) rec("recProdNoDate", { dRecords: prodNoDate }, prodNoDate);
  if (dupP + dupF > 0) rec("recDup", { dProjects: dupP, dProductionGroups: dupF }, dupP + dupF, { n: dupP, m: dupF });
  if (incomplete > 0) rec("recProd", { dRecords: incomplete }, incomplete);
  if (archNoUser > 0) rec("recArchive", { dProjects: archNoUser }, archNoUser);
  if (stopMachines.length > 0) {
    rec("recStoppage", { dStoppages: stopMachines.reduce((s, m) => s + m.stoppages, 0) },
      stopMachines.reduce((s, m) => s + m.stoppages, 0),
      { list: stopMachines.map((m) => `${m.module} ${m.machine}`).join(", ") });
  }

  return {
    remarks,
    recommendations,
    meta: { inactiveProjectsAvailable: inactive != null },
  };
}

// ─────────────────────────────────────────────────────────────
// Filtres (listes de valeurs pour les dropdowns)
// ─────────────────────────────────────────────────────────────

async function filterOptions() {
  const [commercialsList, allUsers, statuses, machinesList, postes, companies, projectsList] = await Promise.all([
    run(
      `SELECT u.id, ${NAME("u", "up")} AS name FROM users u LEFT JOIN user_profiles up ON up."userId" = u.id
       WHERE u.role = 'commercial' OR EXISTS (SELECT 1 FROM projects p WHERE p."ownerId" = u.id)
          OR EXISTS (SELECT 1 FROM commercial_contacts c WHERE c."createdBy" = u.id)
       ORDER BY name`),
    run(`SELECT u.id, ${NAME("u", "up")} AS name FROM users u LEFT JOIN user_profiles up ON up."userId" = u.id ORDER BY name`),
    run(`SELECT DISTINCT TRIM(statut) AS value FROM projects WHERE NULLIF(TRIM(statut),'') IS NOT NULL ORDER BY 1`),
    run(
      `SELECT DISTINCT machine AS value FROM (
         SELECT TRIM(machine) AS machine FROM por_promesh UNION SELECT TRIM(machine) FROM industrial_records
         UNION SELECT TRIM(machine) FROM recuperable_fiches) m WHERE NULLIF(machine,'') IS NOT NULL ORDER BY 1`),
    run(
      `SELECT DISTINCT LOWER(TRIM(poste)) AS value FROM (
         SELECT poste::text AS poste FROM por_promesh UNION SELECT poste::text FROM industrial_records UNION SELECT poste::text FROM recuperable_fiches) s
       WHERE NULLIF(TRIM(poste),'') IS NOT NULL ORDER BY 1`),
    run(`SELECT co.id, co.name FROM companies co WHERE EXISTS (SELECT 1 FROM projects p WHERE p."companyId" = co.id) ORDER BY co.name`),
    run(`SELECT p.id, p."nomProjet" AS name FROM projects p ORDER BY p."updatedAt" DESC LIMIT 300`),
  ]);
  return {
    commercials: commercialsList, users: allUsers, statuses: statuses.map((r) => r.value),
    machines: machinesList.map((r) => r.value), postes: postes.map((r) => r.value),
    modules: ["promesh", "probar"], clients: companies, projects: projectsList,
  };
}

// Notes de traçabilité renvoyées avec les données (capacités réelles du schéma).
function capabilities() {
  return {
    projectCreatedBy: false,
    projectUpdatedBy: "activity-history",
    projectArchivedBy: "approved-archive-requests",
    globalAuditLog: false,
    machineTable: false,
    shiftTable: false,
    stoppageDuration: false,
  };
}

async function fullReport(f) {
  const [ov, com, prj, arch, con, usr, act, ind, mac, dq, prd] = await Promise.all([
    overview(f),
    commercials(f),
    projects(f, { limit: 5000 }),
    projects(f, { archivedOnly: true, limit: 5000 }),
    contacts(f),
    users(f),
    activity(f, { limit: 1000 }),
    industrial(f),
    machines(f, { runsLimit: 1000 }),
    dataQuality(f),
    production(f),
  ]);
  const ins = await insights(f, { users: usr, quality: dq, machines: mac, production: prd });
  return {
    overview: ov, commercials: com, projects: prj, archived: arch, contacts: con,
    users: usr, activity: act, industrial: ind, machines: mac, production: prd, dataQuality: dq, ...ins,
    capabilities: capabilities(),
  };
}

module.exports = {
  parseFilters, overview, commercials, projects, contacts, users, userDetail, activity,
  industrial, machines, production, dataQuality, insights, filterOptions, capabilities, fullReport,
};
