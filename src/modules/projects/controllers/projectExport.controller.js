"use strict";

const ExcelJS = require("exceljs");
const dayjs   = require("dayjs");
const { Op }  = require("sequelize");

const Project     = require("../../../models/Project");
const User        = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

// ── Constants ─────────────────────────────────────────────

const ADMIN_ROLES = ["admin", "superadmin"];

const STATUS_BG = {
  "Prospect":        "FF3b82f6",
  "Identification":  "FF94a3b8",
  "Contacté":        "FF64748b",
  "Visite":          "FF06b6d4",
  "Plan technique":  "FFf59e0b",
  "Echantillonnage": "FFf97316",
  "Devis envoyé":    "FFa78bfa",
  "Négociation":     "FF8b5cf6",
  "Gagné":           "FF10b981",
  "Perdu":           "FFef4444",
  "Fidélisation":    "FF0ea5e9",
  "Offre":           "FFa78bfa",
  "Actif":           "FF10b981",
  "Raté":            "FFef4444",
};

const COL_DEFS = [
  { header: "Nom Projet",        key: "nomProjet",           width: 36 },
  { header: "Type Projet",       key: "typeProjet",          width: 18 },
  { header: "Statut",            key: "statut",              width: 18 },
  { header: "Validation",        key: "validationStatut",    width: 16 },
  { header: "Date Création",     key: "createdAt",           width: 16 },
  { header: "Date Modification", key: "updatedAt",           width: 18 },
  { header: "Architecte",        key: "architecte",          width: 24 },
  { header: "Tél. Architecte",   key: "telephoneArchitecte", width: 18 },
  { header: "Email Architecte",  key: "emailArchitecte",     width: 28 },
  { header: "Ingénieur",         key: "ingenieur",           width: 24 },
  { header: "Tél. Ingénieur",    key: "telephoneIngenieur",  width: 18 },
  { header: "Email Ingénieur",   key: "emailIngenieur",      width: 28 },
  { header: "Promoteur",         key: "promoteur",           width: 24 },
  { header: "Entreprise",        key: "entreprise",          width: 24 },
  { header: "Bureau Étude",      key: "bureauEtude",         width: 24 },
  { header: "Bureau Contrôle",   key: "bureauControle",      width: 24 },
  { header: "Adresse",           key: "adresse",             width: 36 },
  { header: "Latitude",          key: "latitude",            width: 14 },
  { header: "Longitude",         key: "longitude",           width: 14 },
  { header: "Surface (m²)",      key: "surfaceProspectee",   width: 14 },
  { header: "Montant Marché",    key: "montantMarche",       width: 16 },
  { header: "% Réussite",        key: "pourcentageReussite", width: 13 },
  { header: "Archivé",           key: "isArchived",          width: 10 },
  { header: "Motif Archivage",   key: "archiveReason",       width: 28 },
  { header: "Date Archivage",    key: "archivedAt",          width: 18 },
];

const NUM_COLS = COL_DEFS.length;

// ── Style helpers ─────────────────────────────────────────

const DARK_BG  = "FF0f172a";
const HEAD_BG  = "FF1e40af";
const EVEN_BG  = "FFF8FAFC";
const ODD_BG   = "FFFFFFFF";
const WHITE_FG = "FFFFFFFF";
const DARK_FG  = "FF1e293b";
const BORDER_C = "FFcbd5e1";

function thinBorder(color = BORDER_C) {
  const s = { style: "thin", color: { argb: color } };
  return { top: s, left: s, bottom: s, right: s };
}

function cellFill(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function applyRowStyle(row, bgArgb, fgArgb = DARK_FG) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill      = cellFill(bgArgb);
    cell.font      = { color: { argb: fgArgb }, size: 10 };
    cell.border    = thinBorder();
    cell.alignment = { vertical: "middle", wrapText: false };
  });
}

// Auto-width tracker: keep max content length per col index
function makeWidthTracker() {
  const max = {};
  return {
    track(colIdx, text) {
      const len = String(text || "").length;
      if (!max[colIdx] || max[colIdx] < len) max[colIdx] = len;
    },
    applyTo(ws) {
      Object.entries(max).forEach(([idx, len]) => {
        const col = ws.getColumn(Number(idx));
        const def = COL_DEFS[Number(idx) - 1];
        const min = def ? def.width : 10;
        col.width = Math.max(min, Math.min(len + 4, 60));
      });
    },
  };
}

// ── Project → row data ────────────────────────────────────

function projectToRow(p) {
  return {
    nomProjet:            p.nomProjet || "—",
    typeProjet:           p.typeProjet || "—",
    statut:               p.statut || "—",
    validationStatut:     p.validationStatut || "—",
    createdAt:            p.createdAt ? dayjs(p.createdAt).format("YYYY-MM-DD") : "",
    updatedAt:            p.updatedAt ? dayjs(p.updatedAt).format("YYYY-MM-DD") : "",
    architecte:           p.architecte || "—",
    telephoneArchitecte:  p.telephoneArchitecte || "—",
    emailArchitecte:      p.emailArchitecte || "—",
    ingenieur:            p.ingenieurResponsable || "—",
    telephoneIngenieur:   p.telephoneIngenieur || "—",
    emailIngenieur:       p.emailIngenieur || "—",
    promoteur:            p.promoteur || "—",
    entreprise:           p.entreprise || "—",
    bureauEtude:          p.bureauEtude || "—",
    bureauControle:       p.bureauControle || "—",
    adresse:              p.adresse || "—",
    latitude:             p.latitude  != null ? parseFloat(p.latitude)  : "",
    longitude:            p.longitude != null ? parseFloat(p.longitude) : "",
    surfaceProspectee:    p.surfaceProspectee != null ? parseFloat(p.surfaceProspectee) : "",
    montantMarche:        p.montantMarche != null ? parseFloat(p.montantMarche) : "",
    pourcentageReussite:  p.pourcentageReussite != null ? parseFloat(p.pourcentageReussite) : "",
    isArchived:           p.isArchived ? "Oui" : "Non",
    archiveReason:        p.archiveReason || "—",
    archivedAt:           p.archivedAt ? dayjs(p.archivedAt).format("YYYY-MM-DD") : "",
  };
}

// ── Build one sheet per user ──────────────────────────────

function addUserSheet(wb, user, projects) {
  const email       = user.email || "INCONNU";
  const profile     = user.profile || {};
  const displayName = profile.name || email;
  const role        = user.role || "—";
  const count       = projects.length;

  // Sheet name: max 31 chars
  const sheetName = email.toUpperCase().slice(0, 27) + (email.length > 27 ? "..." : "");
  const ws = wb.addWorksheet(sheetName);

  const wt = makeWidthTracker();

  // ── Section 1: User info ────────────────────────────────

  // Title row (merged)
  const titleText = `${email.toUpperCase()} (${count} PROJET${count !== 1 ? "S" : ""})`;
  const titleRow = ws.addRow([titleText]);
  ws.mergeCells(`A${titleRow.number}:Y${titleRow.number}`);
  titleRow.height = 32;
  titleRow.getCell(1).fill      = cellFill(DARK_BG);
  titleRow.getCell(1).font      = { bold: true, size: 13, color: { argb: WHITE_FG } };
  titleRow.getCell(1).alignment = { vertical: "middle", horizontal: "center" };

  // Info rows
  const infoStyle = (cell, bold = false) => {
    cell.fill   = cellFill("FF1e293b");
    cell.font   = { color: { argb: WHITE_FG }, size: 10, bold };
    cell.border = thinBorder("FF334155");
    cell.alignment = { vertical: "middle" };
  };

  const addInfo = (label, value) => {
    const r = ws.addRow([label, value]);
    r.height = 22;
    infoStyle(r.getCell(1), true);
    infoStyle(r.getCell(2));
    // Merge value across remaining columns
    ws.mergeCells(`B${r.number}:Y${r.number}`);
    return r;
  };

  addInfo("Nom utilisateur", displayName);
  addInfo("Email",           email);
  addInfo("Rôle",            role);
  addInfo("Total projets",   count);

  ws.addRow([]); // spacer

  // ── Section 2 & 3: Column headers + project data ────────

  const headerRowNum = ws.rowCount + 1;

  // Column headers
  const headerRow = ws.addRow(COL_DEFS.map((c) => c.header));
  headerRow.height = 28;
  headerRow.eachCell({ includeEmpty: true }, (cell, colIdx) => {
    cell.fill      = cellFill(HEAD_BG);
    cell.font      = { bold: true, color: { argb: WHITE_FG }, size: 10 };
    cell.border    = thinBorder("FF1e3a8a");
    cell.alignment = { vertical: "middle", horizontal: "center" };
    wt.track(colIdx, COL_DEFS[colIdx - 1]?.header || "");
  });

  // Set column definitions for key mapping
  ws.columns = COL_DEFS.map((c) => ({ key: c.key, width: c.width }));

  // Project data rows
  projects.forEach((project, i) => {
    const p   = project.toJSON ? project.toJSON() : project;
    const row = projectToRow(p);
    const bgArgb  = STATUS_BG[p.statut] || (i % 2 === 0 ? EVEN_BG : ODD_BG);
    const fgArgb  = STATUS_BG[p.statut] ? WHITE_FG : DARK_FG;

    const dataRow = ws.addRow(Object.values(row));
    dataRow.height = 20;
    applyRowStyle(dataRow, bgArgb, fgArgb);

    // Track max width
    Object.values(row).forEach((v, idx) => wt.track(idx + 1, v));
  });

  // Frozen panes: freeze header row + column A
  ws.views = [{
    state: "frozen",
    xSplit: 1,
    ySplit: headerRowNum,
    activeCell: "B" + (headerRowNum + 1),
    showGridLines: true,
  }];

  // Auto-filter on header row
  const lastRow  = ws.rowCount;
  const lastCol  = String.fromCharCode(64 + NUM_COLS); // e.g. "Y" for 25 cols
  ws.autoFilter = {
    from: { row: headerRowNum, column: 1 },
    to:   { row: lastRow,      column: NUM_COLS },
  };

  // Apply computed widths
  wt.applyTo(ws);
}

// ── Summary sheet ─────────────────────────────────────────

function addSummarySheet(wb, userSummaries) {
  const ws = wb.addWorksheet("Résumé");
  ws.views = [{ state: "frozen", ySplit: 1 }];

  ws.columns = [
    { header: "Utilisateur",    key: "name",     width: 28 },
    { header: "Email",          key: "email",    width: 34 },
    { header: "Rôle",           key: "role",     width: 16 },
    { header: "Nb Projets",     key: "count",    width: 12 },
    { header: "Archivés",       key: "archived", width: 12 },
    { header: "Validés",        key: "valid",    width: 12 },
    { header: "% Réussite moy", key: "avgRate",  width: 16 },
  ];

  // Header row
  const hRow = ws.getRow(1);
  hRow.height = 28;
  hRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill      = cellFill(DARK_BG);
    cell.font      = { bold: true, color: { argb: WHITE_FG }, size: 11 };
    cell.border    = thinBorder("FF334155");
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  userSummaries.forEach((u, i) => {
    const r = ws.addRow({
      name:    u.name,
      email:   u.email,
      role:    u.role,
      count:   u.count,
      archived: u.archived,
      valid:   u.valid,
      avgRate: u.avgRate !== null ? `${u.avgRate}%` : "—",
    });
    r.height = 22;
    const bgArgb = i % 2 === 0 ? EVEN_BG : "FFf1f5f9";
    r.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill      = cellFill(bgArgb);
      cell.font      = { color: { argb: DARK_FG }, size: 10 };
      cell.border    = thinBorder();
      cell.alignment = { vertical: "middle" };
    });
  });

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: ws.rowCount, column: 7 },
  };
}

// ── Build project WHERE clause ────────────────────────────

function buildProjectWhere(filters, ownerIds) {
  const where = {};

  if (ownerIds && ownerIds.length === 1) {
    where.ownerId = ownerIds[0];
  } else if (ownerIds && ownerIds.length > 1) {
    where.ownerId = { [Op.in]: ownerIds };
  }

  if (filters.type)       where.projectModele   = filters.type;
  if (filters.status)     where.statut          = filters.status;
  if (filters.validation) where.validationStatut = filters.validation;

  if (filters.startDate || filters.endDate) {
    where.dateDemarrage = {};
    if (filters.startDate) where.dateDemarrage[Op.gte] = filters.startDate;
    if (filters.endDate)   where.dateDemarrage[Op.lte] = filters.endDate;
  }

  return where;
}

// ── Main handler ──────────────────────────────────────────

async function exportProjects(req, res) {
  try {
    const isAdmin = ADMIN_ROLES.includes(req.user?.role);
    const { userId, type, status, validation, startDate, endDate } = req.query;

    // ── Determine which users to export ─────────────────────
    let usersToExport = [];

    if (isAdmin && userId) {
      // Admin filtered to one specific user
      const u = await User.findByPk(userId, {
        attributes: ["id", "email", "role"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
      });
      if (u) usersToExport = [u];
    } else if (isAdmin) {
      // Admin: all users that own at least one project
      usersToExport = await User.findAll({
        attributes: ["id", "email", "role"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
        order: [["email", "ASC"]],
      });
    } else {
      // Regular user: only themselves
      const u = await User.findByPk(req.user.sub, {
        attributes: ["id", "email", "role"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
      });
      if (u) usersToExport = [u];
    }

    if (!usersToExport.length) {
      return res.status(404).json({ success: false, message: "Aucun utilisateur trouvé" });
    }

    // ── Fetch all projects in one query ──────────────────────
    const ownerIds = usersToExport.map((u) => u.id);
    const projects = await Project.findAll({
      where: buildProjectWhere({ type, status, validation, startDate, endDate }, ownerIds),
      attributes: { include: [] },
      order: [["ownerId", "ASC"], ["createdAt", "DESC"]],
    });

    // Group projects by ownerId
    const byOwner = {};
    for (const p of projects) {
      const j = p.toJSON ? p.toJSON() : p;
      if (!byOwner[j.ownerId]) byOwner[j.ownerId] = [];
      byOwner[j.ownerId].push(j);
    }

    // ── Build workbook ───────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator  = "CRM PROBAR";
    wb.created  = new Date();
    wb.modified = new Date();

    const summaries = [];

    for (const user of usersToExport) {
      const u        = user.toJSON ? user.toJSON() : user;
      const userProjs = byOwner[u.id] || [];
      const profile   = u.profile || {};

      addUserSheet(wb, { ...u, profile }, userProjs);

      // Compute stats for summary
      const archived = userProjs.filter((p) => p.isArchived).length;
      const valid    = userProjs.filter((p) => p.validationStatut === "Validé").length;
      const rates    = userProjs.map((p) => parseFloat(p.pourcentageReussite)).filter((r) => !isNaN(r));
      const avgRate  = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;

      summaries.push({
        name:    profile.name || u.email,
        email:   u.email,
        role:    u.role,
        count:   userProjs.length,
        archived,
        valid,
        avgRate,
      });
    }

    // Summary sheet only when exporting multiple users
    if (usersToExport.length > 1) {
      addSummarySheet(wb, summaries);
      // Move summary to first position
      wb.moveWorksheet("Résumé", 1);
    }

    // ── Filename & send ──────────────────────────────────────
    const rawEmail  = req.user.email || "";
    const userName  = rawEmail.split("@")[0] || "User";
    const dateStr   = dayjs().format("YYYY-MM-DD");
    const filename  = `Project_List_${userName}_${dateStr}.xlsx`;

    res.setHeader("Content-Type",        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
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
