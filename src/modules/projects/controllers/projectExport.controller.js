"use strict";

const ExcelJS = require("exceljs");
const dayjs   = require("dayjs");
const { Op }  = require("sequelize");

const Project     = require("../../../models/Project");
const User        = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

// ── Roles ─────────────────────────────────────────────────

const ADMIN_ROLES = ["admin", "superadmin"];

// ── Row colour by projectModele / isArchived ──────────────
// Archived takes priority. Otherwise colour by model type.

function rowBg(p) {
  if (p.isArchived)                    return { bg: "FFe2e8f0", fg: "FF64748b" }; // grey
  if (p.projectModele === "revendeur") return { bg: "FFfef3c7", fg: "FF92400e" }; // orange
  if (p.projectModele === "applicateur") return { bg: "FFd1fae5", fg: "FF065f46" }; // green
  return                                       { bg: "FFdbeafe", fg: "FF1e3a8a" }; // blue (project)
}

// ── Column definitions ────────────────────────────────────

const COL_DEFS = [
  { header: "Nom Projet",        key: "nomProjet",            width: 36 },
  { header: "Type",              key: "projectModele",        width: 14 },
  { header: "Statut",            key: "statut",               width: 18 },
  { header: "Validation",        key: "validationStatut",     width: 16 },
  { header: "Date Création",     key: "createdAt",            width: 16 },
  { header: "Date Modification", key: "updatedAt",            width: 18 },
  { header: "Architecte",        key: "architecte",           width: 24 },
  { header: "Email Architecte",  key: "emailArchitecte",      width: 28 },
  { header: "Tél. Architecte",   key: "telephoneArchitecte",  width: 18 },
  { header: "Ingénieur",         key: "ingenieur",            width: 24 },
  { header: "Email Ingénieur",   key: "emailIngenieur",       width: 28 },
  { header: "Tél. Ingénieur",    key: "telephoneIngenieur",   width: 18 },
  { header: "Promoteur",         key: "promoteur",            width: 24 },
  { header: "Entreprise",        key: "entreprise",           width: 24 },
  { header: "Bureau Étude",      key: "bureauEtude",          width: 24 },
  { header: "Bureau Contrôle",   key: "bureauControle",       width: 24 },
  { header: "Adresse",           key: "adresse",              width: 36 },
  { header: "Latitude",          key: "latitude",             width: 13 },
  { header: "Longitude",         key: "longitude",            width: 13 },
  { header: "Montant Marché",    key: "montantMarche",        width: 16 },
  { header: "Surface (m²)",      key: "surfaceProspectee",    width: 14 },
  { header: "Dernière relance",  key: "lastRelanceAt",        width: 18 },
  { header: "Archivé",           key: "isArchived",           width: 10 },
  { header: "Motif Archivage",   key: "archiveReason",        width: 28 },
];

const NUM_COLS = COL_DEFS.length;

// ── Style primitives ──────────────────────────────────────

const C = {
  DARK:     "FF0f172a",
  HEAD:     "FF1e3a8a",
  WHITE:    "FFFFFFFF",
  DARK_TXT: "FF1e293b",
  BORDER:   "FFcbd5e1",
};

function fill(argb)  { return { type: "pattern", pattern: "solid", fgColor: { argb } }; }
function border(c = C.BORDER) {
  const s = { style: "thin", color: { argb: c } };
  return { top: s, left: s, bottom: s, right: s };
}

function styleRow(row, bgArgb, fgArgb = C.DARK_TXT) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill      = fill(bgArgb);
    cell.font      = { color: { argb: fgArgb }, size: 10 };
    cell.border    = border();
    cell.alignment = { vertical: "middle", wrapText: false };
  });
}

// ── Auto-width tracker ────────────────────────────────────

function makeTracker() {
  const m = {};
  return {
    track(colIdx, val) {
      const l = String(val ?? "").length;
      if (!m[colIdx] || m[colIdx] < l) m[colIdx] = l;
    },
    apply(ws) {
      Object.entries(m).forEach(([i, l]) => {
        const def = COL_DEFS[Number(i) - 1];
        const min = def ? def.width : 10;
        ws.getColumn(Number(i)).width = Math.max(min, Math.min(l + 3, 60));
      });
    },
  };
}

// ── Map one project → row values ──────────────────────────

function toRow(p) {
  return [
    p.nomProjet            || "—",
    p.projectModele        || "—",
    p.statut               || "—",
    p.validationStatut     || "—",
    p.createdAt   ? dayjs(p.createdAt).format("YYYY-MM-DD")   : "",
    p.updatedAt   ? dayjs(p.updatedAt).format("YYYY-MM-DD")   : "",
    p.architecte           || "—",
    p.emailArchitecte      || "—",
    p.telephoneArchitecte  || "—",
    p.ingenieurResponsable || "—",
    p.emailIngenieur       || "—",
    p.telephoneIngenieur   || "—",
    p.promoteur            || "—",
    p.entreprise           || "—",
    p.bureauEtude          || "—",
    p.bureauControle       || "—",
    p.adresse              || "—",
    p.latitude    != null ? parseFloat(p.latitude)            : "",
    p.longitude   != null ? parseFloat(p.longitude)           : "",
    p.montantMarche        != null ? parseFloat(p.montantMarche)       : "",
    p.surfaceProspectee    != null ? parseFloat(p.surfaceProspectee)   : "",
    p.lastRelanceAt ? dayjs(p.lastRelanceAt).format("YYYY-MM-DD")      : "",
    p.isArchived ? "Oui" : "Non",
    p.archiveReason        || "—",
  ];
}

// ── Add one sheet per user ────────────────────────────────

function addUserSheet(wb, user, projects) {
  const email   = user.email  || "INCONNU";
  const name    = (user.profile || {}).name || email;
  const role    = user.role   || "—";
  const count   = projects.length;

  // Sheet name ≤ 31 chars
  const sheetName = email.toUpperCase().slice(0, 27) + (email.length > 27 ? "..." : "");
  const ws = wb.addWorksheet(sheetName);

  const tracker = makeTracker();
  let rowNum = 0;

  // ── Title banner ─────────────────────────────────────────
  const titleText = `${email.toUpperCase()}  (${count} PROJET${count !== 1 ? "S" : ""})`;
  const titleRow = ws.addRow([titleText]);
  ws.mergeCells(`A1:${String.fromCharCode(64 + NUM_COLS)}1`);
  titleRow.height = 34;
  titleRow.getCell(1).fill      = fill(C.DARK);
  titleRow.getCell(1).font      = { bold: true, size: 13, color: { argb: C.WHITE } };
  titleRow.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
  rowNum++;

  // ── User info block ───────────────────────────────────────
  const INFO_BG  = "FF1e293b";
  const INFO_FG  = C.WHITE;

  const addInfo = (label, value) => {
    rowNum++;
    const r = ws.addRow([label, String(value)]);
    r.height = 22;
    ws.mergeCells(`B${rowNum}:${String.fromCharCode(64 + NUM_COLS)}${rowNum}`);
    [1, 2].forEach((c) => {
      const cell = r.getCell(c);
      cell.fill      = fill(INFO_BG);
      cell.font      = { bold: c === 1, color: { argb: INFO_FG }, size: 10 };
      cell.border    = border("FF334155");
      cell.alignment = { vertical: "middle" };
    });
  };

  addInfo("Nom utilisateur", name);
  addInfo("Email",           email);
  addInfo("Rôle",            role);
  addInfo("Total projets",   count);

  ws.addRow([]);
  rowNum++;

  // ── Column header row ─────────────────────────────────────
  rowNum++;
  const headerRowNum = rowNum;
  const headerRow    = ws.addRow(COL_DEFS.map((c) => c.header));
  headerRow.height   = 26;
  headerRow.eachCell({ includeEmpty: true }, (cell, ci) => {
    cell.fill      = fill(C.HEAD);
    cell.font      = { bold: true, color: { argb: C.WHITE }, size: 10 };
    cell.border    = border("FF1e3a8a");
    cell.alignment = { vertical: "middle", horizontal: "center" };
    tracker.track(ci, COL_DEFS[ci - 1]?.header);
  });

  // ── Project data rows ─────────────────────────────────────
  projects.forEach((p, i) => {
    rowNum++;
    const { bg, fg } = rowBg(p);
    const values     = toRow(p);
    const dataRow    = ws.addRow(values);
    dataRow.height   = 20;
    styleRow(dataRow, bg, fg);

    values.forEach((v, idx) => tracker.track(idx + 1, v));
  });

  // ── Frozen panes (freeze header + column A) ───────────────
  ws.views = [{
    state:      "frozen",
    xSplit:     1,
    ySplit:     headerRowNum,
    activeCell: `B${headerRowNum + 1}`,
  }];

  // ── AutoFilter on header row ──────────────────────────────
  ws.autoFilter = {
    from: { row: headerRowNum,  column: 1 },
    to:   { row: ws.rowCount,   column: NUM_COLS },
  };

  // ── Set column widths (auto + min) ────────────────────────
  COL_DEFS.forEach((def, i) => {
    ws.getColumn(i + 1).width = def.width;
  });
  tracker.apply(ws);
}

// ── Summary sheet (added FIRST so it opens as default) ────

function addSummarySheet(wb, summaries) {
  const ws = wb.addWorksheet("Résumé");

  const cols = [
    { header: "Utilisateur",   width: 28 },
    { header: "Email",         width: 34 },
    { header: "Rôle",          width: 14 },
    { header: "Nb Projets",    width: 12 },
    { header: "Archivés",      width: 12 },
    { header: "Validés",       width: 12 },
    { header: "% Réussite moy",width: 16 },
  ];

  // Header
  const hRow = ws.addRow(cols.map((c) => c.header));
  hRow.height = 26;
  hRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill      = fill(C.DARK);
    cell.font      = { bold: true, color: { argb: C.WHITE }, size: 11 };
    cell.border    = border("FF334155");
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  summaries.forEach((u, i) => {
    const bgArgb = i % 2 === 0 ? "FFF8FAFC" : "FFf1f5f9";
    const r = ws.addRow([
      u.name, u.email, u.role, u.count,
      u.archived, u.valid,
      u.avgRate !== null ? `${u.avgRate}%` : "—",
    ]);
    r.height = 22;
    r.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill      = fill(bgArgb);
      cell.font      = { color: { argb: C.DARK_TXT }, size: 10 };
      cell.border    = border();
      cell.alignment = { vertical: "middle" };
    });
  });

  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: ws.rowCount, column: cols.length },
  };
}

// ── Build project WHERE clause ────────────────────────────

function buildWhere(f, ownerIds) {
  const where = {};

  if (ownerIds.length === 1)  where.ownerId = ownerIds[0];
  else if (ownerIds.length > 1) where.ownerId = { [Op.in]: ownerIds };

  // Exact match on ENUM/string fields — never use ILIKE on ENUM columns
  if (f.type)       where.projectModele   = f.type;
  if (f.status)     where.statut          = f.status;
  if (f.validation) where.validationStatut = f.validation;

  if (f.startDate || f.endDate) {
    where.dateDemarrage = {};
    if (f.startDate) where.dateDemarrage[Op.gte] = f.startDate;
    if (f.endDate)   where.dateDemarrage[Op.lte]  = f.endDate;
  }

  return where;
}

// ── Main export handler ───────────────────────────────────

async function exportProjects(req, res) {
  try {
    const isAdmin = ADMIN_ROLES.includes(req.user?.role);
    const { userId, type, status, validation, startDate, endDate } = req.query;

    // 1. Determine users to export
    let users = [];

    if (isAdmin && userId) {
      const u = await User.findByPk(userId, {
        attributes: ["id", "email", "role"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
      });
      if (u) users = [u];
    } else if (isAdmin) {
      users = await User.findAll({
        attributes: ["id", "email", "role"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
        order: [["email", "ASC"]],
      });
    } else {
      const u = await User.findByPk(req.user.sub, {
        attributes: ["id", "email", "role"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
      });
      if (u) users = [u];
    }

    if (!users.length) {
      return res.status(404).json({ success: false, message: "Aucun utilisateur trouvé" });
    }

    // 2. Fetch all matching projects in one query, ordered by ownerId then createdAt
    const ownerIds = users.map((u) => u.id);
    const allProjects = await Project.findAll({
      where: buildWhere({ type, status, validation, startDate, endDate }, ownerIds),
      order: [["ownerId", "ASC"], ["createdAt", "DESC"]],
    });

    // Group by ownerId
    const byOwner = {};
    for (const p of allProjects) {
      const j = p.toJSON();
      if (!byOwner[j.ownerId]) byOwner[j.ownerId] = [];
      byOwner[j.ownerId].push(j);
    }

    // 3. Build workbook — summary FIRST (no moveWorksheet needed)
    const wb = new ExcelJS.Workbook();
    wb.creator  = "CRM PROBAR";
    wb.created  = new Date();
    wb.modified = new Date();

    // Compute summaries before creating sheets so summary can go first
    const summaries = users.map((u) => {
      const j       = u.toJSON ? u.toJSON() : u;
      const projs   = byOwner[j.id] || [];
      const archived = projs.filter((p) => p.isArchived).length;
      const valid    = projs.filter((p) => p.validationStatut === "Validé").length;
      const rates    = projs
        .map((p) => parseFloat(p.pourcentageReussite))
        .filter((r) => !isNaN(r));
      const avgRate  = rates.length
        ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length)
        : null;
      return {
        name:     (j.profile || {}).name || j.email,
        email:    j.email,
        role:     j.role,
        count:    projs.length,
        archived,
        valid,
        avgRate,
      };
    });

    // Summary sheet added first → it will be the default/active sheet when Excel opens
    if (users.length > 1) {
      addSummarySheet(wb, summaries);
    }

    // User sheets
    for (const u of users) {
      const j     = u.toJSON ? u.toJSON() : u;
      const projs = byOwner[j.id] || [];
      addUserSheet(wb, j, projs);
    }

    // 4. Send file
    const userPart  = (req.user.email || "").split("@")[0] || "User";
    const dateStr   = dayjs().format("YYYY-MM-DD");
    const filename  = `Project_List_${userPart}_${dateStr}.xlsx`;

    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    const buffer = await wb.xlsx.writeBuffer();
    res.send(buffer);

  } catch (err) {
    console.error("[EXPORT_ERROR]", err);
    res.status(500).json({ success: false, message: err.message || "Export failed" });
  }
}

module.exports = { exportProjects };
