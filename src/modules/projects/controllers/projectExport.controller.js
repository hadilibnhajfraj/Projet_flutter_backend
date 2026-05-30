"use strict";

const ExcelJS = require("exceljs");
const dayjs   = require("dayjs");
const { Op }  = require("sequelize");

const Project     = require("../../../models/Project");
const User        = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

// ── Status → row background / font colour ────────────────

const STATUS_STYLE = {
  "Prospect":        { bg: "FF3b82f6", fg: "FFFFFFFF" },
  "Identification":  { bg: "FF94a3b8", fg: "FFFFFFFF" },
  "Contacté":        { bg: "FF64748b", fg: "FFFFFFFF" },
  "Visite":          { bg: "FF06b6d4", fg: "FFFFFFFF" },
  "Plan technique":  { bg: "FFf59e0b", fg: "FFFFFFFF" },
  "Echantillonnage": { bg: "FFf97316", fg: "FFFFFFFF" },
  "Devis envoyé":    { bg: "FFa78bfa", fg: "FFFFFFFF" },
  "Négociation":     { bg: "FF8b5cf6", fg: "FFFFFFFF" },
  "Gagné":           { bg: "FF10b981", fg: "FFFFFFFF" },
  "Perdu":           { bg: "FFef4444", fg: "FFFFFFFF" },
  "Fidélisation":    { bg: "FF0ea5e9", fg: "FFFFFFFF" },
  // Revendeur statuses
  "Offre":           { bg: "FFa78bfa", fg: "FFFFFFFF" },
  "Actif":           { bg: "FF10b981", fg: "FFFFFFFF" },
  "Raté":            { bg: "FFef4444", fg: "FFFFFFFF" },
};

const DEFAULT_ROW_BG = "FFF8FAFC";
const HEADER_BG      = "FF1e293b";
const BORDER_COLOR   = "FFcbd5e1";

// ── Helpers ───────────────────────────────────────────────

function border(color = BORDER_COLOR) {
  const s = { style: "thin", color: { argb: color } };
  return { top: s, left: s, bottom: s, right: s };
}

function applyRowStyle(row, bgArgb, fgArgb = "FF1e293b") {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
    cell.font = { color: { argb: fgArgb }, size: 10 };
    cell.border = border();
    cell.alignment = { vertical: "middle", wrapText: false };
  });
}

// ── Main handler ──────────────────────────────────────────

async function exportProjects(req, res) {
  try {
    const { type, status, validation, startDate, endDate } = req.query;

    // ── Build WHERE ────────────────────────────────────────
    const where = {};
    if (type)       where.projectModele   = type;
    if (status)     where.statut          = status;
    if (validation) where.validationStatut = validation;

    if (startDate || endDate) {
      where.dateDemarrage = {};
      if (startDate) where.dateDemarrage[Op.gte] = startDate;
      if (endDate)   where.dateDemarrage[Op.lte]  = endDate;
    }

    // ── Fetch projects ─────────────────────────────────────
    const rows = await Project.findAll({
      where,
      include: [
        {
          model: User,
          as: "owner",
          attributes: ["id", "email"],
          include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
          required: false,
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const projects = rows.map((r) => r.toJSON());

    // ── Filename ───────────────────────────────────────────
    const rawEmail   = req.user.email || "";
    const userName   = rawEmail.split("@")[0] || "User";
    const dateStr    = dayjs().format("YYYY-MM-DD");
    const filename   = `Project_List_${userName}_${dateStr}.xlsx`;

    // ── Workbook ───────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator  = "CRM PROBAR";
    wb.created  = new Date();
    wb.modified = new Date();

    // ══════════════════════════════════════════════════════
    // Sheet 1 — Liste Projets
    // ══════════════════════════════════════════════════════
    const ws1 = wb.addWorksheet("Liste Projets", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    ws1.columns = [
      { header: "Projet",          key: "nomProjet",     width: 34 },
      { header: "Utilisateur",     key: "ownerName",     width: 22 },
      { header: "Email",           key: "ownerEmail",    width: 30 },
      { header: "Statut",          key: "statut",        width: 18 },
      { header: "Progression (%)", key: "progression",   width: 16 },
      { header: "Validation",      key: "validation",    width: 16 },
      { header: "Date démarrage",  key: "dateDemarrage", width: 16 },
      { header: "Latitude",        key: "latitude",      width: 14 },
      { header: "Longitude",       key: "longitude",     width: 14 },
      { header: "Adresse chantier",key: "adresse",       width: 36 },
      { header: "Architecte",      key: "architecte",    width: 24 },
      { header: "Ingénieur",       key: "ingenieur",     width: 24 },
      { header: "Entreprise",      key: "entreprise",    width: 24 },
      { header: "Date création",   key: "createdAt",     width: 16 },
    ];

    // Style header
    const headerRow = ws1.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
      cell.font   = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.border = border("FF334155");
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    // Data rows
    for (const p of projects) {
      const ownerProfile = p.owner?.profile || {};
      const ownerName    = ownerProfile.name || p.owner?.email || "—";
      const style        = STATUS_STYLE[p.statut] || null;

      const row = ws1.addRow({
        nomProjet:     p.nomProjet || "—",
        ownerName,
        ownerEmail:    p.owner?.email || "—",
        statut:        p.statut || "—",
        progression:   p.pourcentageReussite != null ? parseFloat(p.pourcentageReussite) : "",
        validation:    p.validationStatut || "—",
        dateDemarrage: p.dateDemarrage || "",
        latitude:      p.latitude  != null ? parseFloat(p.latitude)  : "",
        longitude:     p.longitude != null ? parseFloat(p.longitude) : "",
        adresse:       p.adresse || "—",
        architecte:    p.architecte || "—",
        ingenieur:     p.ingenieurResponsable || "—",
        entreprise:    p.entreprise || "—",
        createdAt:     dayjs(p.createdAt).format("YYYY-MM-DD"),
      });

      row.height = 22;
      applyRowStyle(
        row,
        style ? style.bg : DEFAULT_ROW_BG,
        style ? style.fg : "FF1e293b"
      );
    }

    // ══════════════════════════════════════════════════════
    // Sheet 2 — Statistiques
    // ══════════════════════════════════════════════════════
    const ws2 = wb.addWorksheet("Statistiques");
    ws2.views = [{ showGridLines: false }];
    ws2.getColumn("A").width = 32;
    ws2.getColumn("B").width = 18;

    const total    = projects.length;
    const actifs   = projects.filter((p) => !p.isArchived).length;
    const archives = projects.filter((p) =>  p.isArchived).length;
    const valides  = projects.filter((p) => p.validationStatut === "Validé").length;
    const nonValides = total - valides;

    // Status breakdown
    const byStatus = {};
    for (const p of projects) {
      const s = p.statut || "—";
      byStatus[s] = (byStatus[s] || 0) + 1;
    }

    function addTitle(ws, text) {
      const r = ws.addRow([text, ""]);
      ws.mergeCells(`A${r.number}:B${r.number}`);
      r.height = 34;
      r.getCell(1).font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
      r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
      r.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
    }

    function addStat(ws, label, value, bgArgb = "FFF8FAFC") {
      const r = ws.addRow([label, value]);
      r.height = 26;
      [1, 2].forEach((c) => {
        const cell = r.getCell(c);
        cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
        cell.border = border();
        cell.alignment = { vertical: "middle", horizontal: c === 2 ? "center" : "left" };
      });
      r.getCell(1).font = { bold: true, size: 10, color: { argb: "FF1e293b" } };
      r.getCell(2).font = { bold: true, size: 11, color: { argb: "FF1e293b" } };
    }

    addTitle(ws2, "Statistiques des Projets");
    ws2.addRow([]);

    addStat(ws2, "Total des projets",      total,     "FFe2e8f0");
    addStat(ws2, "Projets actifs",         actifs,    "FFdcfce7");
    addStat(ws2, "Projets archivés",       archives,  "FFfee2e2");
    addStat(ws2, "Projets validés",        valides,   "FFd1fae5");
    addStat(ws2, "Projets non validés",    nonValides,"FFfef9c3");

    ws2.addRow([]);
    addTitle(ws2, "Répartition par Statut");
    ws2.addRow([]);

    for (const [s, count] of Object.entries(byStatus)) {
      const style = STATUS_STYLE[s];
      addStat(ws2, s, count, style ? style.bg.replace(/^FF/, "33") + "40" : "FFF8FAFC");
    }

    // ── Stream to client ───────────────────────────────────
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
