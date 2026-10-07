"use strict";

// Module CONTRÔLE QUALITÉ — fichiers d'export (Excel, PDF A4, CSV) de
// l'Historique et de la Comparaison qualité. Données préparées par
// qualityControlReports.service (mêmes filtres et mêmes règles que l'écran).
//
// Identité : PROMESH = bleu, PROBAR = orange ; statuts vert / rouge / ambre.
// Pas de logo CBI image disponible dans le projet : bandeau texte
// « CBI Tunisia » (aucun logo inventé).

const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const dayjs = require("dayjs");

const cfg = require("../../../config/qualityControl");

const COMPANY = "CBI Tunisia";
const C = {
  ink: "0F172A",
  sub: "64748B",
  border: "CBD5E1",
  head: "1E293B",
  qc: "0EA5E9",
  promesh: "2563EB",
  promeshTint: "DBEAFE",
  probar: "F97316",
  probarTint: "FFEDD5",
  ok: "047857",
  okTint: "D1FAE5",
  nok: "B91C1C",
  nokTint: "FEE2E2",
  warn: "B45309",
  warnTint: "FEF3C7",
  periodA: "7C3AED",
  periodB: "0891B2",
};
const argb = (hex) => `FF${hex}`;

// ── Libellés communs ─────────────────────────────────────────────────────

const RESULT_LABELS = { CONFORME: "Conforme", NON_CONFORME: "Non conforme" };
const ITEM_LABELS = { CONFORME: "Conforme", NON_CONFORME: "Non conforme", NON_CONTROLE: "Non contrôlé" };
const resultLabel = (c) => (c.isValidated ? RESULT_LABELS[c.status] || c.status : "À vérifier");
const statusLabel = (c) => (c.isValidated ? "Validé" : "Brouillon");
const posteLabel = (p) => ({ matin: "Matin", soir: "Soir", nuit: "Nuit" })[p] || (p ? String(p) : "—");
const fmtDate = (iso) => (iso ? dayjs(iso).format("DD/MM/YYYY") : "—");
const lineColor = (type) => (String(type).toUpperCase() === "PROBAR" ? C.probar : C.promesh);
const lineTint = (type) => (String(type).toUpperCase() === "PROBAR" ? C.probarTint : C.promeshTint);

// "30/09/2026" → Date UTC (vraie date Excel, format DD/MM/YYYY).
function excelDate(display) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(display || "");
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : null;
}

function periodText(f) {
  if (f.from && f.to) return `${fmtDate(f.from)} → ${fmtDate(f.to)}`;
  if (f.from) return `Depuis le ${fmtDate(f.from)}`;
  if (f.to) return `Jusqu'au ${fmtDate(f.to)}`;
  if (f.period) return { today: "Aujourd'hui", week: "Cette semaine", month: "Ce mois", year: "Cette année", all: "Toutes" }[f.period] || f.period;
  return "Toutes les dates";
}

function filtersRows(f, actor) {
  const status = f.status
    ? String(f.status)
        .split(",")
        .map((s) => ({ EN_ATTENTE: "À vérifier", EN_COURS: "À vérifier", CONFORME: "Conforme", NON_CONFORME: "Non conforme" })[s] || s)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(", ")
    : "Tous";
  return [
    ["Entreprise", COMPANY],
    ["Période", periodText(f)],
    ["Ligne", f.productionType || "Toutes"],
    ["Machine", f.machine ? `Machine ${f.machine}` : "Toutes"],
    ["Résultat", status],
    ...(f.search ? [["Recherche", f.search]] : []),
    ["Contrôleur", actor.role === cfg.role ? actor.email : "Comptes Contrôle Qualité"],
  ];
}

// Nom de fichier : Rapport_Controle_Qualite[_LIGNE][_MachineN]_<période>.
function historyFileName(f, ext, now = new Date()) {
  const parts = ["Rapport_Controle_Qualite"];
  if (f.productionType) parts.push(f.productionType);
  if (f.machine) parts.push(`Machine${f.machine}`);
  if (f.from || f.to) parts.push([f.from || "debut", f.to || "fin"].join("_"));
  else parts.push(dayjs(now).format("YYYY-MM-DD"));
  return `${parts.join("_")}.${ext}`;
}

function comparisonFileName(data, ext) {
  return `Comparaison_Qualite_${data.periodA.start}_${data.periodB.end}.${ext}`;
}

// ═══ EXCEL ═══════════════════════════════════════════════════════════════

const thin = { style: "thin", color: { argb: argb(C.border) } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = COMPANY;
  wb.company = COMPANY;
  wb.created = new Date();
  return wb;
}

function printSetup(ws, landscape = true) {
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: landscape ? "landscape" : "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
  };
  ws.headerFooter.oddFooter = `&L${COMPANY} — Contrôle Qualité&RPage &P / &N`;
}

// Bandeau titre (2 lignes) commun à toutes les feuilles.
function titleBanner(ws, title, lastCol, subtitle) {
  ws.mergeCells(1, 1, 1, lastCol);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(C.head) } };
  t.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(1).height = 30;
  ws.mergeCells(2, 1, 2, lastCol);
  const s = ws.getCell(2, 1);
  s.value = subtitle;
  s.font = { italic: true, size: 10, color: { argb: argb(C.sub) } };
  s.alignment = { indent: 1 };
}

// Tableau formaté : en-têtes, bordures, filtres Excel, lignes figées.
function table(ws, startRow, columns, rows, { rowStyle, plain } = {}) {
  const header = ws.getRow(startRow);
  columns.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(C.head) } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = box;
    // `plain` : tableau à la suite d'un autre — la colonne garde sa plus grande largeur.
    ws.getColumn(i + 1).width = plain ? Math.max(ws.getColumn(i + 1).width || 0, col.width) : col.width;
  });
  header.height = 30;
  rows.forEach((values, r) => {
    const row = ws.getRow(startRow + 1 + r);
    columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      cell.value = values[i];
      cell.border = box;
      cell.alignment = { vertical: "middle", horizontal: col.align || "left" };
      if (col.numFmt) cell.numFmt = col.numFmt;
    });
    if (rowStyle) rowStyle(row, r);
  });
  if (plain) return;
  ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow + Math.max(rows.length, 1), column: columns.length } };
  ws.views = [{ state: "frozen", ySplit: startRow }];
  ws.pageSetup.printTitlesRow = `${startRow}:${startRow}`;
}

const rate = (v) => (v == null ? null : v / 100); // 82.5 → 0.825 (format %)

function styleResult(cell, label) {
  const tone = label === "Conforme" ? [C.ok, C.okTint] : label === "Non conforme" ? [C.nok, C.nokTint] : [C.warn, C.warnTint];
  cell.font = { bold: true, color: { argb: argb(tone[0]) } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(tone[1]) } };
}

function styleLine(cell, type) {
  cell.font = { bold: true, color: { argb: argb(lineColor(type)) } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(lineTint(type)) } };
}

// Blocs KPI (libellé + grande valeur) sur 3 colonnes.
function kpiBlocks(ws, startRow, kpis) {
  kpis.forEach((k, i) => {
    const col = 1 + (i % 3) * 2;
    const row = startRow + Math.floor(i / 3) * 3;
    ws.mergeCells(row, col, row, col + 1);
    ws.mergeCells(row + 1, col, row + 1, col + 1);
    const label = ws.getCell(row, col);
    label.value = k.label;
    label.font = { bold: true, size: 9, color: { argb: argb(C.sub) } };
    label.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(k.tint) } };
    label.alignment = { horizontal: "center" };
    const value = ws.getCell(row + 1, col);
    value.value = k.value;
    if (k.numFmt) value.numFmt = k.numFmt;
    value.font = { bold: true, size: 20, color: { argb: argb(k.color) } };
    value.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(k.tint) } };
    value.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(row + 1).height = 34;
    for (const r of [row, row + 1]) for (const c of [col, col + 1]) ws.getCell(r, c).border = box;
  });
}

function infoRows(ws, startRow, rows) {
  rows.forEach(([k, v], i) => {
    const r = ws.getRow(startRow + i);
    r.getCell(1).value = k;
    r.getCell(1).font = { bold: true, color: { argb: argb(C.ink) } };
    ws.mergeCells(startRow + i, 2, startRow + i, 6);
    r.getCell(2).value = v;
  });
  return startRow + rows.length;
}

async function buildHistoryExcel({ filters, controls, summary, actor, generatedAt }) {
  const wb = newWorkbook();
  const t = summary.totals;
  const subtitle = `${COMPANY} — généré le ${dayjs(generatedAt).format("DD/MM/YYYY HH:mm")}`;

  // Feuille 1 — Synthèse
  const s1 = wb.addWorksheet("Synthèse", { properties: { tabColor: { argb: argb(C.qc) } } });
  printSetup(s1, false);
  [22, 16, 22, 16, 22, 16].forEach((w, i) => (s1.getColumn(i + 1).width = w));
  titleBanner(s1, "RAPPORT DE CONTRÔLE QUALITÉ", 6, subtitle);
  let row = infoRows(s1, 4, [...filtersRows(filters, actor), ["Date du rapport", dayjs(generatedAt).format("DD/MM/YYYY HH:mm:ss")]]);
  kpiBlocks(s1, row + 1, [
    { label: "TOTAL CONTRÔLES", value: t.total, color: C.ink, tint: "F1F5F9" },
    { label: "CONFORMES", value: t.conformes, color: C.ok, tint: C.okTint },
    { label: "NON CONFORMES", value: t.nonConformes, color: C.nok, tint: C.nokTint },
    { label: "À VÉRIFIER", value: t.aVerifier, color: C.warn, tint: C.warnTint },
    { label: "TAUX DE CONFORMITÉ", value: rate(t.tauxConformite) ?? "N/A", numFmt: "0.0%", color: C.ok, tint: C.okTint },
    { label: "TAUX DE NON-CONFORMITÉ", value: rate(t.tauxNonConformite) ?? "N/A", numFmt: "0.0%", color: C.nok, tint: C.nokTint },
  ]);
  row += 8;
  const note = s1.getCell(row, 1);
  s1.mergeCells(row, 1, row, 6);
  note.value = `${t.total} contrôle(s) — ${t.releves} prélèvement(s) (un contrôle peut porter plusieurs prélèvements). Taux calculés sur les contrôles VALIDÉS ; les brouillons sont comptés « À vérifier ».`;
  note.font = { italic: true, size: 9, color: { argb: argb(C.sub) } };

  // Feuille 2 — Détail des contrôles
  const s2 = wb.addWorksheet("Détail des contrôles", { properties: { tabColor: { argb: argb(C.promesh) } } });
  printSetup(s2);
  titleBanner(s2, "DÉTAIL DES CONTRÔLES", 15, subtitle);
  table(
    s2,
    4,
    [
      { header: "Date", width: 12, numFmt: "dd/mm/yyyy", align: "center" },
      { header: "Heure", width: 10, align: "center" },
      { header: "Ligne", width: 11, align: "center" },
      { header: "Machine", width: 11 },
      { header: "Référence contrôle", width: 16 },
      { header: "Poste", width: 9 },
      { header: "Statut", width: 11 },
      { header: "Résultat", width: 14 },
      { header: "Prélèvements", width: 9, align: "center" },
      { header: "Dernier prélèvement", width: 10, align: "center" },
      { header: "Paramètres contrôlés", width: 12, align: "center" },
      { header: "Paramètres conformes", width: 12, align: "center" },
      { header: "Paramètres non conformes", width: 13, align: "center" },
      { header: "Contrôleur qualité", width: 32 },
      { header: "Date validation", width: 14, numFmt: "dd/mm/yyyy", align: "center" },
    ],
    controls.map((c) => [
      excelDate(c.controlDate),
      c.controlTime,
      c.productionType,
      c.machineLabel || "—",
      c.reference,
      posteLabel(c.poste),
      statusLabel(c),
      resultLabel(c),
      c.readingsCount,
      c.lastReadingTime || "",
      c.counts.controlled,
      c.counts.conformes,
      c.counts.nonConformes,
      controllerName(c.controllerEmail),
      c.validatedDate ? excelDate(c.validatedDate) : null,
    ]),
    {
      rowStyle: (r, i) => {
        styleLine(r.getCell(3), controls[i].productionType);
        styleResult(r.getCell(8), resultLabel(controls[i]));
        if (controls[i].counts.nonConformes > 0) r.getCell(13).font = { bold: true, color: { argb: argb(C.nok) } };
      },
    }
  );

  // Feuille 3 — Paramètres (contrôlés)
  const s3 = wb.addWorksheet("Paramètres", { properties: { tabColor: { argb: argb(C.ok) } } });
  printSetup(s3);
  titleBanner(s3, "DÉTAIL DES PARAMÈTRES CONTRÔLÉS", 10, subtitle);
  const paramRows = [];
  const paramMeta = [];
  for (const c of controls) {
    for (const r of c.readings || []) {
      for (const i of r.items || []) {
        if (i.status === "NON_CONTROLE") continue;
        paramRows.push([c.reference, c.productionType, c.machineLabel || "—", r.readingTime, i.parameterName, i.value ?? "", ITEM_LABELS[i.status] || i.status, i.remark ?? "", excelDate(c.controlDate), controllerName(c.controllerEmail)]);
        paramMeta.push({ type: c.productionType, status: ITEM_LABELS[i.status] });
      }
    }
  }
  table(
    s3,
    4,
    [
      { header: "Référence contrôle", width: 16 },
      { header: "Ligne", width: 11, align: "center" },
      { header: "Machine", width: 11 },
      { header: "Prélèvement", width: 9, align: "center" },
      { header: "Paramètre", width: 38 },
      { header: "Valeur", width: 14 },
      { header: "Statut", width: 14 },
      { header: "Remarque", width: 36 },
      { header: "Date", width: 12, numFmt: "dd/mm/yyyy", align: "center" },
      { header: "Contrôleur qualité", width: 32 },
    ],
    paramRows,
    {
      rowStyle: (r, i) => {
        styleLine(r.getCell(2), paramMeta[i].type);
        styleResult(r.getCell(7), paramMeta[i].status);
        r.getCell(8).alignment = { wrapText: true, vertical: "middle" };
      },
    }
  );

  // Feuille 4 — Contrôle produit (paramètres de niveau fiche : une fois par contrôle).
  const sp = wb.addWorksheet("Contrôle produit", { properties: { tabColor: { argb: argb(C.promesh) } } });
  printSetup(sp);
  titleBanner(sp, "PARAMÈTRES PHYSIQUES DES FICHES", 7, subtitle);
  const physRows = [];
  const physMeta = [];
  for (const c of controls) {
    for (const p of c.physicalParameters || []) {
      if (p.value == null || String(p.value).trim() === "") continue;
      physRows.push([c.reference, c.productionType, c.machineLabel || "—", p.parameterName, p.displayValue ?? p.value, p.unit || "", excelDate(c.controlDate)]);
      physMeta.push(c.productionType);
    }
  }
  table(
    sp,
    4,
    [
      { header: "Référence contrôle", width: 16 },
      { header: "Ligne", width: 11, align: "center" },
      { header: "Machine", width: 11 },
      { header: "Paramètre physique", width: 46 },
      { header: "Valeur", width: 18 },
      { header: "Unité", width: 9, align: "center" },
      { header: "Date", width: 12, numFmt: "dd/mm/yyyy", align: "center" },
    ],
    physRows,
    { rowStyle: (r, i) => styleLine(r.getCell(2), physMeta[i]) }
  );

  // Feuille 5 — Analyse par machine
  const s4 = wb.addWorksheet("Analyse par machine", { properties: { tabColor: { argb: argb(C.probar) } } });
  printSetup(s4, false);
  titleBanner(s4, "ANALYSE PAR MACHINE", 7, subtitle);
  table(
    s4,
    4,
    [
      { header: "Machine", width: 24 },
      { header: "Total contrôles", width: 14, align: "center" },
      { header: "Conformes", width: 12, align: "center" },
      { header: "Non conformes", width: 14, align: "center" },
      { header: "À vérifier", width: 12, align: "center" },
      { header: "Taux conformité", width: 15, numFmt: "0.0%", align: "center" },
      { header: "Taux non-conformité", width: 17, numFmt: "0.0%", align: "center" },
    ],
    summary.byMachine.map((m) => [m.label, m.total, m.conformes, m.nonConformes, m.aVerifier, rate(m.tauxConformite) ?? "N/A", rate(m.tauxNonConformite) ?? "N/A"]),
    { rowStyle: (r, i) => styleLine(r.getCell(1), summary.byMachine[i].type) }
  );
  // Barres de données (exceljs ne génère pas de graphiques natifs).
  if (summary.byMachine.length) {
    const last = 4 + summary.byMachine.length;
    s4.addConditionalFormatting({
      ref: `F5:F${last}`,
      rules: [{ type: "dataBar", cfvo: [{ type: "num", value: 0 }, { type: "num", value: 1 }], color: { argb: argb(C.ok) } }],
    });
    s4.addConditionalFormatting({
      ref: `B5:B${last}`,
      rules: [{ type: "dataBar", cfvo: [{ type: "min" }, { type: "max" }], color: { argb: argb(C.qc) } }],
    });
  }

  return wb.xlsx.writeBuffer();
}

function buildHistoryCsv({ controls }) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Date", "Heure", "Ligne", "Machine", "Référence contrôle", "Poste", "Statut", "Résultat", "Prélèvements", "Dernier prélèvement", "Paramètres contrôlés", "Paramètres conformes", "Paramètres non conformes", "Contrôleur qualité", "Date validation"];
  const lines = controls.map((c) =>
    [c.controlDate, c.controlTime, c.productionType, c.machineLabel || "", c.reference, posteLabel(c.poste), statusLabel(c), resultLabel(c), c.readingsCount, c.lastReadingTime || "", c.counts.controlled, c.counts.conformes, c.counts.nonConformes, controllerName(c.controllerEmail), c.validatedDate || ""]
      .map(esc)
      .join(";")
  );
  return Buffer.from(`﻿${[header.join(";"), ...lines].join("\r\n")}\r\n`, "utf8");
}

// ═══ PDF (A4) ════════════════════════════════════════════════════════════

// Helvetica (police PDF standard) = WinAnsi : les autres caractères sont
// remplacés (jamais de glyphe manquant).
const WIN_ANSI = /[^ -~ -ÿ–—‘’“”•…€™]/g;
const safe = (v) => String(v ?? "").replace(/−/g, "-").replace(/[  ]/g, " ").replace(/→/g, "-").replace(/[\r\n\t]+/g, " ").replace(WIN_ANSI, "?");
const pctText = (v) => (v == null ? "N/A" : `${String(v.toFixed(1)).replace(".", ",")} %`);

function pdfToBuffer(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true, info: { Title: "Rapport de contrôle qualité", Author: COMPANY } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      build(doc);
      // Pied de page numéroté sur chaque page.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // Pied de page DANS la marge basse : marge neutralisée le temps de
        // l'écrire, sinon pdfkit ajouterait une page blanche par numéro.
        const margin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const bottom = doc.page.height - 24;
        doc.font("Helvetica").fontSize(7.5).fillColor(`#${C.sub}`);
        doc.text(safe(`${COMPANY} — Contrôle Qualité`), 36, bottom, { lineBreak: false });
        doc.text(`Page ${i + 1} / ${range.count}`, doc.page.width - 136, bottom, { width: 100, align: "right", lineBreak: false });
        doc.page.margins.bottom = margin;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function pdfHeader(doc, title, subtitle) {
  const W = doc.page.width;
  doc.rect(0, 0, W, 70).fill(`#${C.head}`);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#ffffff").text(safe(title), 36, 22, { width: W - 72 });
  doc.font("Helvetica").fontSize(9).fillColor("#cbd5e1").text(safe(subtitle), 36, 46, { width: W - 72 });
  doc.y = 86;
}

function pdfInfo(doc, rows) {
  const W = doc.page.width - 72;
  let y = doc.y;
  for (const [k, v] of rows) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(`#${C.ink}`).text(safe(k), 36, y, { width: 110, lineBreak: false });
    doc.font("Helvetica").fontSize(9).fillColor(`#${C.ink}`).text(safe(v), 150, y, { width: W - 114, lineBreak: false });
    y += 14;
  }
  doc.y = y + 6;
}

function pdfKpis(doc, kpis) {
  const W = doc.page.width - 72;
  const w = (W - 20) / 3;
  const h = 52;
  const top = doc.y;
  kpis.forEach((k, i) => {
    const x = 36 + (i % 3) * (w + 10);
    const y = top + Math.floor(i / 3) * (h + 10);
    doc.roundedRect(x, y, w, h, 6).fill(`#${k.tint}`);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(`#${C.sub}`).text(safe(k.label), x + 10, y + 9, { width: w - 20, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(20).fillColor(`#${k.color}`).text(safe(k.value), x + 10, y + 23, { width: w - 20, lineBreak: false });
  });
  doc.y = top + Math.ceil(kpis.length / 3) * (h + 10) + 6;
}

// Tableau paginé : en-tête répété à chaque page, lignes zébrées.
function pdfTable(doc, title, columns, rows, { cellColor } = {}) {
  const left = 36;
  const W = doc.page.width - 72;
  const total = columns.reduce((s, c) => s + c.w, 0);
  const widths = columns.map((c) => (c.w / total) * W);
  const rowH = 16;
  const bottom = () => doc.page.height - 48;
  const drawHeader = () => {
    const y = doc.y;
    doc.rect(left, y, W, rowH + 2).fill(`#${C.head}`);
    let x = left;
    columns.forEach((c, i) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff").text(safe(c.h), x + 3, y + 5, { width: widths[i] - 6, lineBreak: false, align: c.align || "left" });
      x += widths[i];
    });
    doc.y = y + rowH + 2;
  };
  if (title) {
    if (doc.y + 60 > bottom()) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(11).fillColor(`#${C.ink}`).text(safe(title), left, doc.y);
    doc.moveDown(0.3);
  }
  drawHeader();
  if (!rows.length) {
    doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(`#${C.sub}`).text("Aucune donnée pour ces critères.", left + 4, doc.y + 4);
    doc.y += 20;
    return;
  }
  rows.forEach((r, ri) => {
    if (doc.y + rowH > bottom()) {
      doc.addPage();
      doc.y = 40;
      drawHeader();
    }
    const y = doc.y;
    if (ri % 2 === 1) doc.rect(left, y, W, rowH).fill("#f8fafc");
    let x = left;
    columns.forEach((c, i) => {
      doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).fillColor(`#${(cellColor && cellColor(ri, i)) || C.ink}`);
      // Une seule ligne par cellule (hauteur bornée + « … ») : jamais de
      // débordement sur la ligne suivante.
      doc.text(safe(r[i]), x + 3, y + 4.5, { width: widths[i] - 6, height: 9, ellipsis: true, align: c.align || "left" });
      x += widths[i];
    });
    doc.moveTo(left, y + rowH).lineTo(left + W, y + rowH).lineWidth(0.3).strokeColor(`#${C.border}`).stroke();
    doc.y = y + rowH;
  });
  doc.y += 10;
}

const resultColor = (label) => (label === "Conforme" ? C.ok : label === "Non conforme" ? C.nok : C.warn);

function buildHistoryPdf({ filters, controls, summary, actor, generatedAt }) {
  const t = summary.totals;
  return pdfToBuffer((doc) => {
    // Page 1 : synthèse
    pdfHeader(doc, "RAPPORT DE CONTRÔLE QUALITÉ", `${COMPANY} — généré le ${dayjs(generatedAt).format("DD/MM/YYYY HH:mm")}`);
    pdfInfo(doc, filtersRows(filters, actor));
    pdfKpis(doc, [
      { label: "TOTAL CONTRÔLES", value: t.total, color: C.ink, tint: "F1F5F9" },
      { label: "CONFORMES", value: t.conformes, color: C.ok, tint: C.okTint },
      { label: "NON CONFORMES", value: t.nonConformes, color: C.nok, tint: C.nokTint },
      { label: "À VÉRIFIER", value: t.aVerifier, color: C.warn, tint: C.warnTint },
      { label: "TAUX DE CONFORMITÉ", value: pctText(t.tauxConformite), color: C.ok, tint: C.okTint },
      { label: "TAUX DE NON-CONFORMITÉ", value: pctText(t.tauxNonConformite), color: C.nok, tint: C.nokTint },
    ]);
    doc.font("Helvetica-Oblique").fontSize(7.5).fillColor(`#${C.sub}`).text("Taux calculés sur les contrôles validés ; brouillons comptés « À vérifier ».", 36, doc.y);
    doc.moveDown(0.8);
    pdfTable(
      doc,
      "Répartition par machine",
      [
        { h: "Machine", w: 22, bold: true },
        { h: "Contrôles", w: 10, align: "center" },
        { h: "Conformes", w: 10, align: "center" },
        { h: "Non conformes", w: 12, align: "center" },
        { h: "À vérifier", w: 10, align: "center" },
        { h: "Taux conformité", w: 13, align: "center" },
        { h: "Taux non-conf.", w: 13, align: "center" },
      ],
      summary.byMachine.map((m) => [m.label, m.total, m.conformes, m.nonConformes, m.aVerifier, pctText(m.tauxConformite), pctText(m.tauxNonConformite)]),
      { cellColor: (ri, ci) => (ci === 0 ? lineColor(summary.byMachine[ri].type) : null) }
    );
    // Pages 2+ : détail paginé
    doc.addPage();
    doc.y = 40;
    pdfTable(
      doc,
      `Détail des contrôles (${controls.length})`,
      [
        { h: "Date", w: 15 },
        { h: "Ligne", w: 9, bold: true },
        { h: "Machine", w: 10 },
        { h: "Référence", w: 14 },
        { h: "Poste", w: 7 },
        { h: "Résultat", w: 12 },
        { h: "Prélèvements", w: 7, align: "center" },
        { h: "Contrôlés", w: 8, align: "center" },
        { h: "Non conf.", w: 8, align: "center" },
        { h: "Contrôleur", w: 17 },
      ],
      controls.map((c) => [qcDateTime(c), c.productionType, c.machineLabel || "—", c.reference, posteLabel(c.poste), resultLabel(c), c.readingsCount, c.counts.controlled, c.counts.nonConformes, controllerName(c.controllerEmail)]),
      {
        cellColor: (ri, ci) => {
          if (ci === 1) return lineColor(controls[ri].productionType);
          if (ci === 5) return resultColor(resultLabel(controls[ri]));
          if (ci === 8 && controls[ri].counts.nonConformes > 0) return C.nok;
          return null;
        },
      }
    );
  });
}

// "controle_qualite@cbi-tunisia.com" → "controle_qualite" (comme à l'écran).
// Nom affiché du contrôleur : le compte du rôle Contrôle Qualité
// (controle_qualite@…) est présenté « Contrôle Qualité », jamais par son
// identifiant technique ; tout autre compte par son adresse.
function controllerName(email) {
  const local = String(email || "").split("@")[0];
  return local === cfg.role ? "Contrôle Qualité" : String(email || "—");
}

// eslint-disable-next-line no-unused-vars
function controllerShort(email) {
  const at = String(email || "").indexOf("@");
  return at > 0 ? email.slice(0, at) : email || "—";
}

function qcDateTime(c) {
  return `${c.controlDate} ${String(c.controlTime || "").slice(0, 5)}`.trim();
}

// ═══ COMPARAISON ═════════════════════════════════════════════════════════
//
// Données de qualityControlComparison.service : tout ce qui est écrit ici
// (KPI, variations, paramètres, points d'attention, analyse) vient de la
// réponse calculée par PostgreSQL — aucune valeur par défaut.

const KPI_ROWS = [
  ["Contrôles", "total", "count"],
  ["Conformes", "conformes", "count"],
  ["Non conformes", "nonConformes", "count"],
  ["À vérifier", "aVerifier", "count"],
  ["Taux de conformité", "tauxConformite", "rate"],
  ["Taux de non-conformité", "tauxNonConformite", "rate"],
  ["Paramètres contrôlés", "parametresControles", "count"],
  ["Paramètres non conformes", "parametresNonConformes", "count"],
  ["Machines contrôlées", "machinesControlees", "count"],
  ["Prélèvements", "releves", "count"],
  ["Moy. paramètres contrôlés / contrôle", "moyenneParametresControles", "avg"],
  ["Moy. non-conformités / contrôle", "moyenneParametresNonConformes", "avg"],
];
// KPI communs aux deux lignes (seuls comparables entre PROMESH et PROBAR).
const COMMON_KPI_KEYS = ["total", "conformes", "nonConformes", "tauxConformite", "tauxNonConformite", "machinesControlees", "releves", "parametresControles"];
const COMMON_KPI_ROWS = KPI_ROWS.filter(([, key]) => COMMON_KPI_KEYS.includes(key));
const SHIFT_KPI_ROWS = KPI_ROWS.filter(([, key]) => ["total", "tauxConformite", "tauxNonConformite"].includes(key));
const RESULT_FILTER_LABELS = { CONFORME: "Conforme", NON_CONFORME: "Non conforme", A_VERIFIER: "À vérifier (brouillon)" };

const num = (v, digits) => String(v.toFixed(digits)).replace(".", ",");
const signed = (v, digits) => `${v > 0 ? "+" : ""}${digits == null ? v : num(v, digits)}`;

// Variation : jamais calculée quand une période est vide (N/A).
function evolutionText(kind, evo) {
  if (!evo) return "—";
  if (kind === "rate") return evo.points == null ? "N/A" : `${signed(evo.points, 1)} pt`;
  if (kind === "avg") return evo.absolue == null ? "N/A" : signed(evo.absolue, 2);
  if (evo.absolue == null) return "N/A";
  return evo.relative == null ? `${signed(evo.absolue)} (N/A)` : `${signed(evo.absolue)} (${signed(evo.relative, 1)} %)`;
}

const pointsText = (v) => evolutionText("rate", { points: v });
const valueText = (kind, v) => (kind === "rate" ? pctText(v) : v == null ? "N/A" : kind === "avg" ? num(v, 2) : String(v));

function comparisonInfo(data) {
  const f = data.filters;
  return [
    ["Entreprise", COMPANY],
    ["Période A", `${fmtDate(data.periodA.start)} → ${fmtDate(data.periodA.end)}`],
    ["Période B", `${fmtDate(data.periodB.start)} → ${fmtDate(data.periodB.end)}`],
    ["Ligne", f.productionType || "Toutes"],
    ["Machine", f.machine ? `Machine ${f.machine}` : "Toutes"],
    ["Poste", f.poste ? posteLabel(f.poste) : "Tous"],
    ["Contrôleur", data.controleur ? controllerName(data.controleur) : "Tous (comptes Contrôle Qualité)"],
    ["Résultat", f.result ? RESULT_FILTER_LABELS[f.result] || f.result : "Tous"],
    ["Date de génération", dayjs(data.generatedAt).format("DD/MM/YYYY HH:mm")],
  ];
}

// Titre + tableau, à la suite sur la même feuille. Retourne la ligne libre
// suivante.
function block(ws, row, title, columns, rows, opts = {}) {
  const t = ws.getCell(row, 1);
  t.value = title;
  t.font = { bold: true, size: 12, color: { argb: argb(C.ink) } };
  table(ws, row + 1, columns, rows, { ...opts, plain: true });
  if (!rows.length) {
    const empty = ws.getCell(row + 2, 1);
    empty.value = "Aucune donnée pour ces critères.";
    empty.font = { italic: true, color: { argb: argb(C.sub) } };
  }
  return row + 1 + Math.max(rows.length, 1) + 2;
}

function noteRow(ws, row, lastCol, text, { color = C.sub, tint, bold = false } = {}) {
  ws.mergeCells(row, 1, row, lastCol);
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = { bold, italic: !bold, color: { argb: argb(color) } };
  cell.alignment = { wrapText: true, vertical: "middle", indent: 1 };
  if (tint) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(tint) } };
  // Hauteur selon la longueur (texte renvoyé à la ligne).
  ws.getRow(row).height = Math.max(18, Math.ceil(String(text).length / 95) * 15);
  return row + 1;
}

async function buildComparisonExcel(data) {
  const wb = newWorkbook();
  const a = data.periodA;
  const b = data.periodB;
  const subtitle = `${COMPANY} — Contrôle Qualité — généré le ${dayjs(data.generatedAt).format("DD/MM/YYYY HH:mm")}`;
  const valueCell = (kind, v) => (v == null ? "N/A" : kind === "rate" ? v / 100 : v);
  const fmtFor = (kind) => (kind === "rate" ? "0.0%" : kind === "avg" ? "0.00" : "0");
  const evoColor = (cell, v, goodWhenUp = true) => {
    if (v == null || v === 0) return;
    cell.font = { bold: true, color: { argb: argb(v > 0 === goodWhenUp ? C.ok : C.nok) } };
  };

  // Feuille 1 — Synthèse : périodes, filtres, état des données, analyse.
  const s1 = wb.addWorksheet("Synthèse", { properties: { tabColor: { argb: argb(C.qc) } } });
  printSetup(s1, false);
  [26, 16, 26, 16, 26, 16].forEach((w, i) => (s1.getColumn(i + 1).width = w));
  titleBanner(s1, "CONTRÔLE QUALITÉ — COMPARAISON", 6, subtitle);
  let row = infoRows(s1, 4, comparisonInfo(data)) + 1;
  for (const m of data.messages) row = noteRow(s1, row, 6, m.text, { color: C.warn, tint: C.warnTint, bold: true });
  row += 1;
  kpiBlocks(s1, row, [
    { label: "CONTRÔLES — PÉRIODE A", value: a.total, color: C.periodA, tint: "F1F5F9" },
    { label: "CONTRÔLES — PÉRIODE B", value: b.total, color: C.periodB, tint: "F1F5F9" },
    { label: "VARIATION", value: evolutionText("count", data.evolution.total), color: C.ink, tint: "F1F5F9" },
    { label: "TAUX DE CONFORMITÉ — PÉRIODE A", value: valueCell("rate", a.tauxConformite), numFmt: "0.0%", color: C.periodA, tint: "F1F5F9" },
    { label: "TAUX DE CONFORMITÉ — PÉRIODE B", value: valueCell("rate", b.tauxConformite), numFmt: "0.0%", color: C.periodB, tint: "F1F5F9" },
    { label: "VARIATION (POINTS)", value: evolutionText("rate", data.evolution.tauxConformite), color: C.ink, tint: "F1F5F9" },
  ]);
  row += 7;
  s1.getCell(row, 1).value = "Analyse";
  s1.getCell(row, 1).font = { bold: true, size: 12, color: { argb: argb(C.ink) } };
  row += 1;
  for (const line of data.analysis) row = noteRow(s1, row, 6, line, { color: C.ink });
  noteRow(s1, row + 1, 6, "Analyse calculée à partir des contrôles enregistrés. Taux sur les contrôles VALIDÉS ; brouillons comptés « À vérifier » ; variation des taux en points.");

  // Feuilles 2 et 3 — une période : indicateurs, lignes, machines, jours.
  const breakdown = [
    { header: "", width: 38 },
    { header: "Contrôles", width: 14, align: "center" },
    { header: "Conformes", width: 12, align: "center" },
    { header: "Non conformes", width: 14, align: "center" },
    { header: "À vérifier", width: 12, align: "center" },
    { header: "Taux de conformité", width: 15, numFmt: "0.0%", align: "center" },
    { header: "Prélèvements", width: 10, align: "center" },
  ];
  const breakdownRow = (label, v) => [label, v.total, v.conformes, v.nonConformes, v.aVerifier, valueCell("rate", v.tauxConformite), v.releves];
  const periodSheet = (name, key, color) => {
    const p = data[key];
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: argb(color) } } });
    printSetup(ws, false);
    titleBanner(ws, `${name.toUpperCase()} — ${fmtDate(p.start)} → ${fmtDate(p.end)}`, 7, subtitle);
    let r = 4;
    if (p.total === 0) r = noteRow(ws, r, 7, `Aucune donnée disponible pour la ${name.toLowerCase()}`, { color: C.warn, tint: C.warnTint, bold: true }) + 1;
    r = block(
      ws,
      r,
      "Indicateurs",
      [
        { header: "Indicateur", width: 38 },
        { header: "Valeur", width: 14, align: "center" },
      ],
      KPI_ROWS.map(([label, k, kind]) => [label, valueCell(kind, p[k])]),
      {
        rowStyle: (x, i) => {
          x.getCell(2).numFmt = fmtFor(KPI_ROWS[i][2]);
          x.getCell(2).font = { bold: true, color: { argb: argb(color) } };
        },
      }
    );
    r = block(ws, r, "Par ligne", [{ ...breakdown[0], header: "Ligne" }, ...breakdown.slice(1)], data.byType.map((l) => breakdownRow(l.label, l[key])), {
      rowStyle: (x, i) => styleLine(x.getCell(1), data.byType[i].type),
    });
    r = block(ws, r, "Par machine", [{ ...breakdown[0], header: "Machine" }, ...breakdown.slice(1)], data.byMachine.map((m) => breakdownRow(m.label, m[key])), {
      rowStyle: (x, i) => styleLine(x.getCell(1), data.byMachine[i].type),
    });
    r = block(ws, r, "Par poste", [{ ...breakdown[0], header: "Poste" }, ...breakdown.slice(1)], data.byShift.map((s) => breakdownRow(s.label, s[key])));
    block(
      ws,
      r,
      "Par jour (date du contrôle)",
      [
        { header: "Date", width: 38, numFmt: "dd/mm/yyyy", align: "left" },
        { header: "Contrôles", width: 14, align: "center" },
        { header: "Conformes", width: 12, align: "center" },
        { header: "Non conformes", width: 14, align: "center" },
        { header: "Validés", width: 12, align: "center" },
        { header: "Taux de conformité", width: 15, numFmt: "0.0%", align: "center" },
      ],
      data.daily[key].map((d) => [excelDate(fmtDate(d.date)), d.total, d.conformes, d.nonConformes, d.valides, valueCell("rate", d.tauxConformite)])
    );
  };
  periodSheet("Période A", "periodA", C.periodA);
  periodSheet("Période B", "periodB", C.periodB);

  // Feuille 4 — Comparaison : 12 KPI, puis lignes (KPI communs) et postes.
  const s4 = wb.addWorksheet("Comparaison", { properties: { tabColor: { argb: argb(C.ok) } } });
  printSetup(s4, false);
  titleBanner(s4, "COMPARAISON PÉRIODE A / PÉRIODE B", 4, subtitle);
  const cmpColumns = (first) => [
    { header: first, width: 44 },
    { header: "Période A", width: 16, align: "center" },
    { header: "Période B", width: 16, align: "center" },
    { header: "Variation", width: 22, align: "center" },
  ];
  const cmpStyle = (kinds, types) => (r, i) => {
    r.getCell(2).numFmt = fmtFor(kinds[i]);
    r.getCell(3).numFmt = fmtFor(kinds[i]);
    r.getCell(2).font = { bold: true, color: { argb: argb(C.periodA) } };
    r.getCell(3).font = { bold: true, color: { argb: argb(C.periodB) } };
    if (types) styleLine(r.getCell(1), types[i]);
  };
  const cmpRows = (rows, entry, prefix = "") => rows.map(([label, key, kind]) => [`${prefix}${label}`, valueCell(kind, entry.periodA[key]), valueCell(kind, entry.periodB[key]), evolutionText(kind, entry.evolution[key])]);
  table(s4, 4, cmpColumns("Indicateur"), cmpRows(KPI_ROWS, data), { rowStyle: cmpStyle(KPI_ROWS.map((k) => k[2])) });
  row = 4 + KPI_ROWS.length + 3;
  if (data.byType.length > 1) {
    // Entre lignes : KPI communs uniquement (jamais de paramètre propre à une ligne).
    row = block(
      s4,
      row,
      "PROMESH / PROBAR — indicateurs communs",
      cmpColumns("Ligne — indicateur"),
      data.byType.flatMap((l) => cmpRows(COMMON_KPI_ROWS, l, `${l.label} — `)),
      { rowStyle: cmpStyle(data.byType.flatMap(() => COMMON_KPI_ROWS.map((k) => k[2])), data.byType.flatMap((l) => COMMON_KPI_ROWS.map(() => l.type))) }
    );
  }
  row = block(
    s4,
    row,
    "Matin / Soir",
    cmpColumns("Poste — indicateur"),
    data.byShift.flatMap((s) => cmpRows(SHIFT_KPI_ROWS, s, `${s.label} — `)),
    { rowStyle: cmpStyle(data.byShift.flatMap(() => SHIFT_KPI_ROWS.map((k) => k[2]))) }
  );
  if (data.shiftInsight) noteRow(s4, row, 4, data.shiftInsight, { color: C.ink });

  // Feuille 5 — Par machine (classement sur la période B si plusieurs machines).
  const s5 = wb.addWorksheet("Par machine", { properties: { tabColor: { argb: argb(C.promesh) } } });
  printSetup(s5);
  titleBanner(s5, "COMPARAISON PAR MACHINE", 8, subtitle);
  const rankOf = new Map((data.ranking?.machines || []).map((m, i) => [`${m.type}:${m.machine}`, i + 1]));
  table(
    s5,
    4,
    [
      { header: "Machine", width: 24 },
      { header: "Contrôles A", width: 12, align: "center" },
      { header: "Contrôles B", width: 12, align: "center" },
      { header: "Variation", width: 18, align: "center" },
      { header: "Taux de conformité A", width: 13, numFmt: "0.0%", align: "center" },
      { header: "Taux de conformité B", width: 13, numFmt: "0.0%", align: "center" },
      { header: "Variation du taux", width: 15, align: "center" },
      { header: "Rang (période B)", width: 12, align: "center" },
    ],
    data.byMachine.map((m) => [
      m.label,
      m.periodA.total,
      m.periodB.total,
      evolutionText("count", m.evolution.total),
      valueCell("rate", m.periodA.tauxConformite),
      valueCell("rate", m.periodB.tauxConformite),
      evolutionText("rate", m.evolution.tauxConformite),
      rankOf.get(`${m.type}:${m.machine}`) ?? "—",
    ]),
    {
      rowStyle: (r, i) => {
        styleLine(r.getCell(1), data.byMachine[i].type);
        evoColor(r.getCell(7), data.byMachine[i].evolution.tauxConformite.points);
      },
    }
  );
  row = 4 + Math.max(data.byMachine.length, 1) + 2;
  if (data.ranking) {
    row = noteRow(s5, row, 8, `Meilleure performance (période B) : ${data.ranking.best.label} — ${pctText(data.ranking.best.tauxConformite)}`, { color: C.ok, bold: true });
    noteRow(s5, row, 8, `Performance à surveiller (période B) : ${data.ranking.worst.label} — ${pctText(data.ranking.worst.tauxConformite)}`, { color: C.nok, bold: true });
  } else {
    noteRow(s5, row, 8, data.filters.machine ? "Une seule machine sélectionnée : évolution entre les deux périodes (pas de classement)." : "Classement non établi : moins de deux machines ont des contrôles validés sur la période B.");
  }

  // Feuille 6 — Par paramètre (uniquement ceux contrôlés sur ces périodes).
  const s6 = wb.addWorksheet("Par paramètre", { properties: { tabColor: { argb: argb(C.probar) } } });
  printSetup(s6);
  titleBanner(s6, "ÉVOLUTION DES PARAMÈTRES", 11, subtitle);
  table(
    s6,
    4,
    [
      { header: "Ligne", width: 11, align: "center" },
      { header: "Catégorie", width: 30 },
      { header: "Paramètre", width: 38 },
      { header: "Contrôlés A", width: 11, align: "center" },
      { header: "Non conformes A", width: 12, align: "center" },
      { header: "Conformité A", width: 12, numFmt: "0.0%", align: "center" },
      { header: "Contrôlés B", width: 11, align: "center" },
      { header: "Non conformes B", width: 12, align: "center" },
      { header: "Conformité B", width: 12, numFmt: "0.0%", align: "center" },
      { header: "Évolution", width: 12, align: "center" },
      { header: "Fiabilité", width: 18 },
    ],
    data.parameters.map((p) => [
      p.type,
      p.sectionLabel,
      p.label,
      p.periodA.controles,
      p.periodA.nonConformes,
      valueCell("rate", p.periodA.tauxConformite),
      p.periodB.controles,
      p.periodB.nonConformes,
      valueCell("rate", p.periodB.tauxConformite),
      pointsText(p.evolutionPoints),
      p.limited ? "Données limitées" : "",
    ]),
    {
      rowStyle: (r, i) => {
        styleLine(r.getCell(1), data.parameters[i].type);
        evoColor(r.getCell(10), data.parameters[i].evolutionPoints);
      },
    }
  );

  // Feuille 7 — Points d'attention (dégradations) et améliorations.
  const s7 = wb.addWorksheet("Points d'attention", { properties: { tabColor: { argb: argb(C.nok) } } });
  printSetup(s7, false);
  titleBanner(s7, "POINTS D'ATTENTION ET AMÉLIORATIONS", 6, subtitle);
  const moveColumns = [
    { header: "Ligne", width: 11, align: "center" },
    { header: "Paramètre", width: 40 },
    { header: "Conformité A", width: 14, numFmt: "0.0%", align: "center" },
    { header: "Conformité B", width: 14, numFmt: "0.0%", align: "center" },
    { header: "Évolution", width: 14, align: "center" },
    { header: "Fiabilité", width: 18 },
  ];
  const moveRows = (list) => list.map((p) => [p.type, p.label, valueCell("rate", p.periodA.tauxConformite), valueCell("rate", p.periodB.tauxConformite), pointsText(p.evolutionPoints), p.limited ? "Données limitées" : ""]);
  const moveStyle = (list) => (r, i) => {
    styleLine(r.getCell(1), list[i].type);
    evoColor(r.getCell(5), list[i].evolutionPoints);
  };
  row = block(s7, 4, "Points d'attention — paramètres dont la conformité diminue", moveColumns, moveRows(data.attentionPoints), { rowStyle: moveStyle(data.attentionPoints) });
  block(s7, row, "Améliorations — paramètres dont la conformité augmente", moveColumns, moveRows(data.improvements), { rowStyle: moveStyle(data.improvements) });

  return wb.xlsx.writeBuffer();
}

// ── PDF : graphiques ─────────────────────────────────────────────────────

function pdfLegend(doc, right, y) {
  [["Période A", C.periodA], ["Période B", C.periodB]].forEach(([label, color], i) => {
    const x = right - 170 + i * 85;
    doc.rect(x, y, 9, 9).fill(`#${color}`);
    doc.font("Helvetica").fontSize(8).fillColor(`#${C.ink}`).text(safe(label), x + 13, y, { lineBreak: false });
  });
}

function pdfChartTitle(doc, title, height) {
  if (doc.y + height > doc.page.height - 48) {
    doc.addPage();
    doc.y = 40;
  }
  doc.font("Helvetica-Bold").fontSize(11).fillColor(`#${C.ink}`).text(safe(title), 36, doc.y);
  return doc.y + 18;
}

// Barres groupées A / B — légende + valeurs affichées.
function pdfGroupedBars(doc, title, groups) {
  const left = 36;
  const W = doc.page.width - 72;
  const H = 110;
  const top = pdfChartTitle(doc, title, H + 60);
  pdfLegend(doc, left + W, top - 14);
  const max = Math.max(1, ...groups.flatMap((g) => [g.a ?? 0, g.b ?? 0]));
  const gw = W / groups.length;
  const bw = Math.min(46, gw / 3);
  groups.forEach((g, i) => {
    const cx = left + gw * i + gw / 2;
    [[g.a, C.periodA, -1], [g.b, C.periodB, 1]].forEach(([v, color, side]) => {
      const h = ((v ?? 0) / max) * H;
      const x = side < 0 ? cx - bw - 1 : cx + 1;
      if (h > 0) doc.rect(x, top + H - h, bw, h).fill(`#${color}`);
      doc.font("Helvetica-Bold").fontSize(8).fillColor(`#${C.ink}`).text(String(v ?? 0), x - 6, top + H - h - 11, { width: bw + 12, align: "center", lineBreak: false });
    });
    doc.font("Helvetica").fontSize(8.5).fillColor(`#${C.sub}`).text(safe(g.label), left + gw * i, top + H + 5, { width: gw, align: "center", lineBreak: false });
  });
  doc.moveTo(left, top + H).lineTo(left + W, top + H).lineWidth(0.5).strokeColor(`#${C.border}`).stroke();
  doc.y = top + H + 26;
}

// Barres de conformité (0 → 100 %) : une par période + variation en points.
function pdfRateBars(doc, title, rows, footer) {
  const left = 36;
  const W = doc.page.width - 72;
  let y = pdfChartTitle(doc, title, 40 + rows.length * 22);
  const x = left + 70;
  const w = W - 70 - 64;
  rows.forEach((r) => {
    doc.font("Helvetica").fontSize(9).fillColor(`#${C.ink}`).text(safe(r.label), left, y + 2, { width: 66, lineBreak: false });
    doc.roundedRect(x, y, w, 12, 3).fill("#e2e8f0");
    if (r.value != null && r.value > 0) doc.roundedRect(x, y, Math.max(6, (w * r.value) / 100), 12, 3).fill(`#${r.color}`);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(`#${C.ink}`).text(pctText(r.value), x + w + 8, y + 2, { width: 56, lineBreak: false });
    y += 20;
  });
  if (footer) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(`#${C.ink}`).text(safe(footer), left, y + 2, { lineBreak: false });
    y += 16;
  }
  doc.y = y + 12;
}

// Courbe : taux de conformité par jour, les deux périodes superposées sur le
// rang du jour dans la période (J1 = premier jour). Seuls les jours ayant des
// contrôles validés portent un point.
function pdfLineChart(doc, title, data) {
  const series = [
    [C.periodA, data.periodA.start, data.daily.periodA],
    [C.periodB, data.periodB.start, data.daily.periodB],
  ].map(([color, start, rows]) => ({
    color,
    points: rows.filter((r) => r.tauxConformite != null).map((r) => ({ x: dayjs(r.date).diff(dayjs(start), "day"), y: r.tauxConformite })),
  }));
  if (!series.some((s) => s.points.length)) return;
  const left = 36 + 30;
  const W = doc.page.width - 72 - 30;
  const H = 100;
  const top = pdfChartTitle(doc, title, H + 60);
  pdfLegend(doc, left + W, top - 14);
  const maxX = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.x)));
  const px = (x) => left + (x / maxX) * W;
  const py = (y) => top + H - (y / 100) * H;
  for (const tick of [0, 50, 100]) {
    doc.moveTo(left, py(tick)).lineTo(left + W, py(tick)).lineWidth(0.4).strokeColor(`#${C.border}`).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(`#${C.sub}`).text(`${tick} %`, 36, py(tick) - 4, { width: 26, align: "right", lineBreak: false });
  }
  for (const s of series) {
    if (s.points.length > 1) {
      doc.moveTo(px(s.points[0].x), py(s.points[0].y));
      s.points.slice(1).forEach((p) => doc.lineTo(px(p.x), py(p.y)));
      doc.lineWidth(1.5).strokeColor(`#${s.color}`).stroke();
    }
    s.points.forEach((p) => doc.circle(px(p.x), py(p.y), 2.5).fill(`#${s.color}`));
  }
  doc.font("Helvetica").fontSize(7.5).fillColor(`#${C.sub}`);
  doc.text("J1", left - 4, top + H + 5, { lineBreak: false });
  doc.text(`J${maxX + 1}`, left + W - 30, top + H + 5, { width: 30, align: "right", lineBreak: false });
  doc.text(safe("Jour de la période"), left, top + H + 5, { width: W, align: "center", lineBreak: false });
  doc.y = top + H + 26;
}

function pdfParagraphs(doc, title, lines, color = C.ink) {
  const left = 36;
  const W = doc.page.width - 72;
  if (doc.y + 50 > doc.page.height - 48) {
    doc.addPage();
    doc.y = 40;
  }
  if (title) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(`#${C.ink}`).text(safe(title), left, doc.y);
    doc.moveDown(0.3);
  }
  for (const line of lines) {
    doc.font("Helvetica").fontSize(9).fillColor(`#${color}`).text(safe(`• ${line}`), left + 4, doc.y, { width: W - 8 });
    doc.moveDown(0.25);
  }
  doc.y += 8;
}

function buildComparisonPdf(data) {
  const a = data.periodA;
  const b = data.periodB;
  const moveColumns = [
    { h: "Ligne", w: 12, bold: true },
    { h: "Paramètre", w: 44, bold: true },
    { h: "Conformité A", w: 15, align: "center" },
    { h: "Conformité B", w: 15, align: "center" },
    { h: "Évolution", w: 14, align: "center" },
  ];
  const moveRows = (list) => list.map((p) => [p.type, p.label, pctText(p.periodA.tauxConformite), pctText(p.periodB.tauxConformite), `${pointsText(p.evolutionPoints)}${p.limited ? " *" : ""}`]);
  return pdfToBuffer((doc) => {
    // Bandeau texte « CBI Tunisia » : aucun fichier de logo dans le projet.
    pdfHeader(doc, "CONTRÔLE QUALITÉ — COMPARAISON", `${COMPANY} — généré le ${dayjs(data.generatedAt).format("DD/MM/YYYY HH:mm")}`);
    pdfInfo(doc, comparisonInfo(data));
    if (data.messages.length) pdfParagraphs(doc, null, data.messages.map((m) => m.text), C.warn);
    pdfTable(
      doc,
      "Indicateurs",
      [
        { h: "Indicateur", w: 34, bold: true },
        { h: "Période A", w: 20, align: "center" },
        { h: "Période B", w: 20, align: "center" },
        { h: "Variation", w: 26, align: "center" },
      ],
      KPI_ROWS.map(([label, key, kind]) => [label, valueText(kind, a[key]), valueText(kind, b[key]), evolutionText(kind, data.evolution[key])]),
      { cellColor: (ri, ci) => (ci === 1 ? C.periodA : ci === 2 ? C.periodB : null) }
    );
    // Graphiques : uniquement s'il existe des contrôles à représenter.
    if (a.total + b.total > 0) {
      pdfGroupedBars(doc, "Résultats des contrôles : période A / période B", [
        { label: "Conformes", a: a.conformes, b: b.conformes },
        { label: "Non conformes", a: a.nonConformes, b: b.nonConformes },
        { label: "À vérifier", a: a.aVerifier, b: b.aVerifier },
      ]);
      pdfRateBars(
        doc,
        "Taux de conformité (contrôles validés)",
        [
          { label: "Période A", value: a.tauxConformite, color: C.periodA },
          { label: "Période B", value: b.tauxConformite, color: C.periodB },
        ],
        `Variation : ${evolutionText("rate", data.evolution.tauxConformite)}`
      );
      pdfLineChart(doc, "Taux de conformité par jour", data);
    }
    pdfParagraphs(doc, "Analyse", data.analysis);

    doc.addPage();
    doc.y = 40;
    pdfTable(
      doc,
      data.ranking ? "Comparaison par machine (classement sur la période B)" : "Comparaison par machine",
      [
        { h: "Machine", w: 24, bold: true },
        { h: "Contrôles A", w: 11, align: "center" },
        { h: "Contrôles B", w: 11, align: "center" },
        { h: "Variation", w: 18, align: "center" },
        { h: "Taux A", w: 11, align: "center" },
        { h: "Taux B", w: 11, align: "center" },
        { h: "Var. taux", w: 14, align: "center" },
      ],
      data.byMachine.map((m) => [m.label, m.periodA.total, m.periodB.total, evolutionText("count", m.evolution.total), pctText(m.periodA.tauxConformite), pctText(m.periodB.tauxConformite), evolutionText("rate", m.evolution.tauxConformite)]),
      { cellColor: (ri, ci) => (ci === 0 ? lineColor(data.byMachine[ri].type) : null) }
    );
    if (data.ranking) {
      pdfParagraphs(doc, null, [`Meilleure performance : ${data.ranking.best.label} (${pctText(data.ranking.best.tauxConformite)})`], C.ok);
      doc.y -= 8;
      pdfParagraphs(doc, null, [`Performance à surveiller : ${data.ranking.worst.label} (${pctText(data.ranking.worst.tauxConformite)})`], C.nok);
    }
    if (data.byType.length > 1) {
      pdfTable(
        doc,
        "PROMESH / PROBAR — indicateurs communs",
        [
          { h: "Ligne", w: 16, bold: true },
          { h: "Contrôles A / B", w: 18, align: "center" },
          { h: "Conformes A / B", w: 18, align: "center" },
          { h: "Non conformes A / B", w: 20, align: "center" },
          { h: "Taux de conformité A / B", w: 28, align: "center" },
        ],
        data.byType.map((l) => [
          l.label,
          `${l.periodA.total} / ${l.periodB.total}`,
          `${l.periodA.conformes} / ${l.periodB.conformes}`,
          `${l.periodA.nonConformes} / ${l.periodB.nonConformes}`,
          `${pctText(l.periodA.tauxConformite)} / ${pctText(l.periodB.tauxConformite)}`,
        ]),
        { cellColor: (ri, ci) => (ci === 0 ? lineColor(data.byType[ri].type) : null) }
      );
    }
    pdfTable(
      doc,
      "Matin / Soir",
      [
        { h: "Poste", w: 16, bold: true },
        { h: "Contrôles A / B", w: 18, align: "center" },
        { h: "Taux de conformité A / B", w: 28, align: "center" },
        { h: "Taux de non-conformité A / B", w: 28, align: "center" },
      ],
      data.byShift.map((s) => [
        s.label,
        `${s.periodA.total} / ${s.periodB.total}`,
        `${pctText(s.periodA.tauxConformite)} / ${pctText(s.periodB.tauxConformite)}`,
        `${pctText(s.periodA.tauxNonConformite)} / ${pctText(s.periodB.tauxNonConformite)}`,
      ])
    );
    if (data.shiftInsight) pdfParagraphs(doc, null, [data.shiftInsight]);
    pdfTable(
      doc,
      "Évolution des paramètres (conformité des paramètres contrôlés)",
      [
        { h: "Ligne", w: 11, bold: true },
        { h: "Paramètre", w: 40, bold: true },
        { h: "Contrôlés A / B", w: 15, align: "center" },
        { h: "Conformité A", w: 13, align: "center" },
        { h: "Conformité B", w: 13, align: "center" },
        { h: "Évolution", w: 12, align: "center" },
      ],
      data.parameters.map((p) => [p.type, p.label, `${p.periodA.controles} / ${p.periodB.controles}`, pctText(p.periodA.tauxConformite), pctText(p.periodB.tauxConformite), `${pointsText(p.evolutionPoints)}${p.limited ? " *" : ""}`]),
      {
        cellColor: (ri, ci) => {
          if (ci === 0) return lineColor(data.parameters[ri].type);
          const v = data.parameters[ri].evolutionPoints;
          return ci === 5 && v ? (v > 0 ? C.ok : C.nok) : null;
        },
      }
    );
    pdfTable(doc, "Points d'attention", moveColumns, moveRows(data.attentionPoints), { cellColor: (ri, ci) => (ci === 0 ? lineColor(data.attentionPoints[ri].type) : ci === 4 ? C.nok : null) });
    pdfTable(doc, "Améliorations", moveColumns, moveRows(data.improvements), { cellColor: (ri, ci) => (ci === 0 ? lineColor(data.improvements[ri].type) : ci === 4 ? C.ok : null) });
    if (data.parameters.some((p) => p.limited)) {
      doc.font("Helvetica-Oblique").fontSize(7.5).fillColor(`#${C.sub}`).text(safe("* Données limitées : moins de 2 mesures du paramètre sur une des périodes."), 36, doc.y);
    }
  });
}

module.exports = {
  buildHistoryExcel,
  buildHistoryPdf,
  buildHistoryCsv,
  buildComparisonExcel,
  buildComparisonPdf,
  historyFileName,
  comparisonFileName,
};
