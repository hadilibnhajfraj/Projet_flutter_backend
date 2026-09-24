"use strict";

const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const dayjs = require("dayjs");
const { makeT } = require("./reportsI18n");

const fmtDate = (d) => (d ? dayjs(d).format("DD/MM/YYYY") : "");
const fmtDateTime = (d) => (d ? dayjs(d).format("DD/MM/YYYY HH:mm") : "");
const num = (v) => (v == null ? "" : Number(v));

function periodLabel(f, t) {
  if (!f.from && !f.toEx) return t("allPeriod");
  const a = f.from ? dayjs(f.from).format("DD/MM/YYYY") : "…";
  const b = f.toEx ? dayjs(f.toEx).subtract(1, "day").format("DD/MM/YYYY") : "…";
  return `${a} - ${b}`;
}

function appliedFilters(f, t, names = {}) {
  const out = [];
  if (f.from) out.push([t("fFrom"), fmtDate(f.from)]);
  if (f.toEx) out.push([t("fTo"), dayjs(f.toEx).subtract(1, "day").format("DD/MM/YYYY")]);
  if (f.commercialId) out.push([t("fCommercial"), names[f.commercialId] || f.commercialId]);
  if (f.userId) out.push([t("fUser"), names[f.userId] || f.userId]);
  if (f.statut) out.push([t("fStatus"), f.statut]);
  if (f.projectId) out.push([t("fProject"), names[f.projectId] || f.projectId]);
  if (f.companyId) out.push([t("fClient"), names[f.companyId] || f.companyId]);
  if (f.machine) out.push([t("fMachine"), f.machine]);
  if (f.module) out.push([t("fModule"), f.module.toUpperCase()]);
  if (f.poste) out.push([t("fShift"), t(`shift_${f.poste}`)]);
  return out;
}

const shiftLabel = (t, s) => {
  const k = `shift_${s}`;
  const v = t(k);
  return v === k ? s : v;
};

const eventLabel = (t, type) => {
  const map = {
    project_created: "evProjectCreated", project_modified: "evProjectModified", project_stage: "evProjectStage",
    project_archived: "evProjectArchived", project_unarchived: "evProjectUnarchived",
    contact_created: "evContactCreated", action_created: "evActionCreated",
    relance_created: "evRelanceCreated", fiche_created: "evFicheCreated",
  };
  return map[type] ? t(map[type]) : type;
};
const moduleLabel = (t, m) => {
  const map = { project: "modProject", contact: "modContact", action: "modAction", relance: "modRelance", fiche: "modFiche" };
  return map[m] ? t(map[m]) : m;
};

const KPI_KEYS = {
  totalProjects: "kTotalProjects", projectsCreated: "kProjectsCreated", projectsModified: "kProjectsModified",
  projectsArchived: "kProjectsArchived", projectsArchivedPeriod: "kProjectsArchivedPeriod",
  totalContacts: "kTotalContacts", newContacts: "kNewContacts", totalUsers: "kTotalUsers",
  activeUsers: "kActiveUsers", totalFiches: "kTotalFiches", promeshProduction: "kPromeshProduction",
  probarProduction: "kProbarProduction",
};

// ─────────────────────────────────────────────────────────────
// Tables partagées (Excel + PDF) — { title, columns:[{h,w,v(row)}], rows }
// ─────────────────────────────────────────────────────────────

function buildTables(data, f, t) {
  const na = t("notAvailable");
  const userOrNa = (v) => v || na;

  const commercials = {
    title: t("shCommercials"),
    columns: [
      { h: t("cCommercial"), w: 26, v: (r) => r.name },
      { h: t("cProjectsCreated"), w: 12, v: (r) => r.projectsCreated },
      { h: t("cProjectsActive"), w: 12, v: (r) => r.projectsActive },
      { h: t("cProjectsWon"), w: 12, v: (r) => r.projectsWon },
      { h: t("cProjectsLost"), w: 12, v: (r) => r.projectsLost },
      { h: t("cProjectsArchived"), w: 12, v: (r) => r.projectsArchived },
      { h: t("cContactsCreated"), w: 12, v: (r) => r.contactsCreated },
      { h: t("cActions"), w: 10, v: (r) => r.actions },
      { h: t("cRelances"), w: 10, v: (r) => r.relances },
      { h: t("cLastProject"), w: 28, v: (r) => r.lastProject || "" },
      { h: t("cLastProjectAt"), w: 16, v: (r) => fmtDate(r.lastProjectAt) },
      { h: t("cLastActivity"), w: 18, v: (r) => fmtDateTime(r.lastActivityAt) },
    ],
    rows: data.commercials,
  };

  const projectCols = (archived) => [
    { h: t("cProject"), w: 32, v: (r) => r.name },
    { h: t("cClient"), w: 24, v: (r) => r.client || "" },
    { h: t("cOwner"), w: 22, v: (r) => r.owner || "" },
    { h: t("cCreatedBy"), w: 16, v: () => na },
    { h: t("cCreatedAt"), w: 16, v: (r) => fmtDateTime(r.createdAt) },
    { h: t("cUpdatedAt"), w: 18, v: (r) => fmtDateTime(r.updatedAt) },
    { h: t("cUpdatedBy"), w: 22, v: (r) => userOrNa(r.updatedBy) },
    { h: t("cStatus"), w: 16, v: (r) => r.status || "" },
    ...(archived
      ? [
          { h: t("cArchivedBy"), w: 22, v: (r) => userOrNa(r.archivedBy) },
          { h: t("cArchivedAt"), w: 16, v: (r) => fmtDateTime(r.archivedAt) },
          { h: t("cReason"), w: 30, v: (r) => r.archiveReason || "" },
        ]
      : [
          { h: t("cArchivedBy"), w: 22, v: (r) => (r.isArchived ? userOrNa(r.archivedBy) : "") },
          { h: t("cArchivedAt"), w: 16, v: (r) => fmtDateTime(r.archivedAt) },
        ]),
    { h: t("cLastAction"), w: 16, v: (r) => fmtDate(r.lastActionAt) },
    { h: t("cLastRelance"), w: 16, v: (r) => fmtDate(r.lastRelanceAt) },
    { h: t("cLastActivity"), w: 18, v: (r) => fmtDateTime(r.lastActivityAt) },
  ];

  const contacts = {
    title: t("shContacts"),
    columns: [
      { h: t("cCommercial"), w: 26, v: (r) => r.name },
      { h: t("cContactsCreated"), w: 14, v: (r) => r.contactsCreated },
      { h: t("cLastContact"), w: 28, v: (r) => r.lastContact || "" },
      { h: t("cLastContactAt"), w: 18, v: (r) => fmtDateTime(r.lastContactAt) },
      { h: t("cUpdatedAt"), w: 18, v: (r) => fmtDateTime(r.lastModifiedAt) },
      { h: t("cLastActivity"), w: 18, v: (r) => fmtDateTime(r.lastActivityAt) },
    ],
    rows: data.contacts.rows,
  };

  const users = {
    title: t("shUsers"),
    columns: [
      { h: t("cName"), w: 26, v: (r) => r.name },
      { h: t("cEmail"), w: 30, v: (r) => r.email },
      { h: t("cRole"), w: 16, v: (r) => r.role },
      { h: t("cFiches"), w: 10, v: (r) => r.fiches },
      { h: t("cProjectsCreated"), w: 12, v: (r) => r.projectsCreated },
      { h: t("cProjectsModified"), w: 12, v: (r) => r.projectsModified },
      { h: t("cProjectsArchived"), w: 12, v: (r) => r.projectsArchived },
      { h: t("cContactsCreated"), w: 12, v: (r) => r.contactsCreated },
      { h: t("cActions"), w: 10, v: (r) => r.actionsCreated },
      { h: t("cRelances"), w: 10, v: (r) => r.relancesCreated },
      { h: t("cDocuments"), w: 10, v: (r) => r.documents },
      { h: t("cLastActivity"), w: 18, v: (r) => fmtDateTime(r.lastActivityAt) },
    ],
    rows: data.users,
  };

  const activity = {
    title: t("shActivity"),
    columns: [
      { h: t("cDate"), w: 12, v: (r) => fmtDate(r.at) },
      { h: t("cTime"), w: 8, v: (r) => dayjs(r.at).format("HH:mm") },
      { h: t("cUser"), w: 24, v: (r) => r.userName || na },
      { h: t("cRole"), w: 14, v: (r) => r.userRole || "" },
      { h: t("cModule"), w: 12, v: (r) => moduleLabel(t, r.module) },
      { h: t("cObject"), w: 30, v: (r) => r.label || "" },
      { h: t("cAction"), w: 20, v: (r) => eventLabel(t, r.type) },
      { h: t("cReference"), w: 18, v: (r) => r.ref },
      { h: t("cStatus"), w: 14, v: (r) => r.status || "" },
    ],
    rows: data.activity.rows,
  };

  const perDayCols = (withWaste) => [
    { h: t("cDate"), w: 14, v: (r) => r.date },
    { h: t("cFichesCount"), w: 10, v: (r) => r.fiches },
    { h: t("cQuantity"), w: 14, v: (r) => num(r.quantity) },
    ...(withWaste ? [{ h: t("cWaste"), w: 14, v: (r) => (r.waste == null ? na : num(r.waste)) }] : []),
  ];
  const promesh = { title: t("shPromesh"), columns: perDayCols(true), rows: data.industrial.promesh?.perDay || [] };
  const probar = { title: t("shProbar"), columns: perDayCols(true), rows: data.industrial.probar?.perDay || [] };

  const machines = {
    title: t("shMachines"),
    columns: [
      { h: t("cModuleName"), w: 12, v: (r) => r.module },
      { h: t("cMachine"), w: 12, v: (r) => r.machine },
      { h: t("cFichesCount"), w: 10, v: (r) => r.fiches },
      { h: t("cQuantity"), w: 14, v: (r) => num(r.quantity) },
      { h: t("cWaste"), w: 12, v: (r) => (r.waste == null ? na : num(r.waste)) },
      { h: t("cFirst"), w: 16, v: (r) => fmtDate(r.firstAt) },
      { h: t("cLast"), w: 16, v: (r) => fmtDate(r.lastAt) },
      ...["matin", "nuit"].map((s) => ({ h: `${t("cShift")} ${shiftLabel(t, s)}`, w: 14, v: (r) => r.shifts?.[s] ?? 0 })),
      { h: t("cStoppages"), w: 14, v: (r) => (r.stoppages == null ? na : r.stoppages) },
      { h: t("cMaintenance"), w: 14, v: (r) => r.maintenanceSheets },
    ],
    rows: data.machines.machines,
  };

  const quality = {
    title: t("shQuality"),
    columns: [
      { h: t("cType"), w: 50, v: (r) => t(r.type) },
      { h: t("cCount"), w: 10, v: (r) => r.count },
      { h: t("cExamples"), w: 50, v: (r) => r.examples.join(" | ") },
      { h: t("cImpact"), w: 44, v: (r) => t(r.impactKey) },
    ],
    rows: data.dataQuality.checks.filter((c) => c.count > 0),
  };

  const recommendations = {
    title: t("shRecommendations"),
    columns: [
      { h: t("cFinding"), w: 50, v: (r) => r.finding },
      { h: t("cData"), w: 22, v: (r) => r.dataText },
      { h: t("cImpact"), w: 36, v: (r) => r.impact },
      { h: t("cRecommendation"), w: 60, v: (r) => r.recommendation },
    ],
    rows: data.recommendations,
  };

  const prodDaily = {
    title: t("shProdDaily"),
    columns: [
      { h: t("cDate"), w: 14, v: (r) => fmtDate(r.date) },
      { h: "PROD 1", w: 12, v: (r) => r.prod1 },
      { h: "PROD 2", w: 12, v: (r) => r.prod2 },
      { h: t("cTotal"), w: 12, v: (r) => r.total },
    ],
    rows: data.production.daily,
  };
  const prodUsers = {
    title: t("shProdUsers"),
    columns: [
      { h: t("cUser"), w: 30, v: (r) => r.name || na },
      { h: "PROD 1", w: 10, v: (r) => r.prod1 },
      { h: "PROD 2", w: 10, v: (r) => r.prod2 },
      { h: t("cTotal"), w: 10, v: (r) => r.total },
      { h: t("cFirstCreation"), w: 18, v: (r) => fmtDateTime(r.firstAt) },
      { h: t("cLastCreation"), w: 18, v: (r) => fmtDateTime(r.lastAt) },
    ],
    rows: data.production.users,
  };

  return {
    prodDaily, prodUsers,
    commercials,
    projects: { title: t("shProjects"), columns: projectCols(false), rows: data.projects.rows },
    archived: { title: t("shArchived"), columns: projectCols(true), rows: data.archived.rows },
    contacts, users, activity, promesh, probar, machines, quality, recommendations,
  };
}

function summaryRows(data, t, lang) {
  const dec = (v) => (lang === "fr" ? String(v).replace(".", ",") : String(v));
  return data.overview.kpis.map((k) => [
    t(KPI_KEYS[k.key]),
    num(k.value),
    k.previous == null ? t("notAvailable") : num(k.previous),
    k.variationPct == null ? t("notAvailable") : `${k.variationPct > 0 ? "+" : ""}${dec(k.variationPct)} %`,
  ]);
}

async function userNames(data) {
  const names = {};
  for (const u of data.users) names[u.id] = u.name;
  return names;
}

// ─────────────────────────────────────────────────────────────
// Excel
// ─────────────────────────────────────────────────────────────

async function buildExcel(data, f) {
  const t = makeT(f.lang);
  const tables = buildTables(data, f, t);
  const names = await userNames(data);
  const wb = new ExcelJS.Workbook();
  wb.creator = "PROBAR CRM";
  wb.created = new Date();

  const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };
  const styleHeader = (row) => {
    row.eachCell((c) => {
      c.fill = HEADER_FILL;
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });
    row.height = 24;
  };

  // Sheet 1 — Synthèse
  const s1 = wb.addWorksheet(`01_${t("shSummary")}`);
  s1.columns = [{ width: 38 }, { width: 18 }, { width: 22 }, { width: 16 }];
  s1.mergeCells("A1:D1");
  s1.getCell("A1").value = t("reportTitle");
  s1.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF1E3A8A" } };
  s1.addRow([t("analyzedPeriod"), periodLabel(f, t)]);
  s1.addRow([t("generatedOn"), fmtDateTime(new Date())]);
  const flt = appliedFilters(f, t, names);
  s1.addRow([t("filtersApplied"), flt.length ? flt.map(([k, v]) => `${k}: ${v}`).join(" | ") : t("none")]);
  s1.addRow([]);
  styleHeader(s1.addRow([t("cIndicator"), t("cValue"), t("cPrevious"), t("cVariation")]));
  for (const r of summaryRows(data, t, f.lang)) s1.addRow(r);
  s1.addRow([]);
  styleHeader(s1.addRow([t("sRemarks"), "", "", ""]));
  if (data.remarks.length === 0) s1.addRow([t("rNoRemarks")]);
  for (const r of data.remarks) {
    s1.addRow([r.text, r.kind === "recorded" ? t("noteRecorded") : t("noteInterpretation")]);
  }
  s1.addRow([]);
  for (const k of ["noteOwnerAsCreator", "noteArchivedBy", "noteUpdatedBy", "noteWasteSources"]) s1.addRow([t(k)]);

  const order = [
    "commercials", "projects", "archived", "contacts", "users", "activity",
    "promesh", "probar", "machines", "quality", "recommendations", "prodDaily", "prodUsers",
  ];
  for (const [i, key] of order.entries()) {
    const tb = tables[key];
    const ws = wb.addWorksheet(`${String(i + 2).padStart(2, "0")}_${tb.title}`.slice(0, 31));
    ws.columns = tb.columns.map((c) => ({ header: c.h, width: c.w }));
    styleHeader(ws.getRow(1));
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of tb.rows) ws.addRow(tb.columns.map((c) => c.v(row)));
    if (tb.rows.length === 0) ws.addRow([t("notAvailable")]);
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: tb.columns.length } };
  }
  return wb.xlsx.writeBuffer();
}

// ─────────────────────────────────────────────────────────────
// PDF
// ─────────────────────────────────────────────────────────────

// Helvetica (police PDF standard) ne sait afficher que WinAnsi : tout autre
// caractère (flèches, alphabets non latins…) est remplacé pour ne jamais
// produire de glyphe manquant.
const WIN_ANSI = /[^ -~ -ÿ–—‘’“”•…€™]/g;
const safe = (v) => String(v ?? "").replace(/[  ]/g, " ").replace(/→/g, "-").replace(/[\r\n\t]+/g, " ").replace(WIN_ANSI, "?");

async function buildPdf(data, f) {
  const t = makeT(f.lang);
  const tables = buildTables(data, f, t);
  const names = await userNames(data);
  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: t("reportTitle"), Author: "PROBAR CRM" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const W = doc.page.width - 80;
  const BLUE = "#1e3a8a";
  const GREY = "#6b7280";
  const ensure = (h) => {
    if (doc.y + h > doc.page.height - 60) doc.addPage();
  };
  let sectionNo = 0;
  const h1 = (txt) => {
    ensure(60);
    sectionNo += 1;
    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(14).fillColor(BLUE).text(safe(`${sectionNo}. ${txt}`), 40);
    doc.moveTo(40, doc.y + 2).lineTo(40 + W, doc.y + 2).strokeColor(BLUE).lineWidth(1).stroke();
    doc.moveDown(0.5).fillColor("#111827");
  };
  const h2 = (txt) => {
    ensure(40);
    doc.moveDown(0.5).font("Helvetica-Bold").fontSize(10.5).fillColor("#111827").text(safe(txt), 40);
    doc.moveDown(0.2);
  };
  const para = (txt, opts = {}) => {
    ensure(20);
    doc.font("Helvetica").fontSize(9).fillColor(opts.color || "#111827").text(safe(txt), 40, doc.y, { width: W });
  };
  const kv = (pairs) => {
    for (const [k, v] of pairs) {
      ensure(14);
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text(safe(k), 40, y, { width: 170, lineBreak: false });
      doc.font("Helvetica").fontSize(9).text(safe(v), 215, y, { width: W - 175, lineBreak: false });
      doc.y = y + 13;
    }
    doc.x = 40;
  };

  const barChart = (title, items) => {
    if (!items || items.length === 0) return;
    const rows = items.slice(0, 10);
    const max = Math.max(...rows.map((r) => r.value), 1);
    ensure(20 + rows.length * 16);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(safe(title), 40);
    doc.moveDown(0.2);
    for (const r of rows) {
      ensure(16);
      const y = doc.y;
      doc.font("Helvetica").fontSize(8).fillColor("#374151").text(safe(r.label).slice(0, 26), 40, y, { width: 150, lineBreak: false });
      const bw = ((W - 210) * r.value) / max;
      doc.rect(195, y, Math.max(bw, 1), 9).fill(BLUE);
      doc.fillColor("#111827").text(String(Math.round(r.value * 100) / 100), 200 + bw, y, { width: 60, lineBreak: false });
      doc.y = y + 14;
    }
    doc.moveDown(0.4);
    doc.x = 40;
  };

  const table = (tb, maxRows = 25, maxCols = 8) => {
    const cols = tb.columns.slice(0, maxCols);
    if (tb.rows.length === 0) {
      para(t("notAvailable"), { color: GREY });
      return;
    }
    const totalW = cols.reduce((s, c) => s + c.w, 0);
    const widths = cols.map((c) => (c.w / totalW) * W);
    const drawRow = (vals, bold) => {
      const h = 14;
      ensure(h + 4);
      let x = 40;
      const y = doc.y;
      if (bold) doc.rect(40, y - 2, W, h).fill(BLUE);
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(7).fillColor(bold ? "#ffffff" : "#111827");
      vals.forEach((v, i) => {
        doc.text(safe(v).slice(0, Math.max(3, Math.floor(widths[i] / 3.3))), x + 2, y, { width: widths[i] - 4, lineBreak: false });
        x += widths[i];
      });
      doc.y = y + h;
    };
    drawRow(cols.map((c) => c.h), true);
    tb.rows.slice(0, maxRows).forEach((r) => drawRow(cols.map((c) => c.v(r)), false));
    if (tb.rows.length > maxRows) para(`... ${tb.rows.length - maxRows} / ${tb.rows.length} (Excel)`, { color: GREY });
    doc.x = 40;
  };

  // ── Page de garde ──
  doc.rect(0, 0, doc.page.width, 210).fill(BLUE);
  doc.font("Helvetica-Bold").fontSize(30).fillColor("#ffffff").text(safe(t("reportTitle")), 40, 80, { width: W });
  doc.font("Helvetica").fontSize(14).fillColor("#dbeafe").text(safe(t("coverSubtitle")), 40, 130, { width: W });
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text(safe(`${t("analyzedPeriod")} :`), 40, 250);
  doc.font("Helvetica").fontSize(12).text(safe(periodLabel(f, t)), 40, 268);
  const flt = appliedFilters(f, t, names);
  doc.font("Helvetica-Bold").fontSize(11).text(safe(`${t("filtersApplied")} :`), 40, 310);
  doc.font("Helvetica").fontSize(10).text(safe(flt.length ? flt.map(([k, v]) => `${k}: ${v}`).join("  |  ") : t("none")), 40, 328, { width: W });
  doc.font("Helvetica").fontSize(10).fillColor(GREY).text(safe(`${t("generatedOn")} ${fmtDateTime(new Date())}`), 40, 380);
  doc.text(safe(t("pdfExplainNA")), 40, 396, { width: W });
  doc.addPage();
  doc.y = 40;

  // ── 1. Synthèse ──
  h1(t("sSummary"));
  table({
    columns: [
      { h: t("cIndicator"), w: 40, v: (r) => r.label }, { h: t("cValue"), w: 15, v: (r) => r.value },
      { h: t("cPrevious"), w: 20, v: (r) => r.prev }, { h: t("cVariation"), w: 15, v: (r) => r.varr },
    ],
    rows: summaryRows(data, t, f.lang).map(([label, value, prev, varr]) => ({ label, value, prev, varr })),
  }, 30, 4);
  doc.moveDown(0.5);
  barChart(t("chProjectsPerStatus"), data.overview.charts.projectsByStatus);

  // ── 2. Activité commerciale ──
  h1(t("sCommercials"));
  barChart(t("chProjectsPerCommercial"), data.commercials.map((c) => ({ label: c.name, value: c.projectsCreated })).filter((x) => x.value > 0));
  table({
    columns: [
      { h: t("cCommercial"), w: 28, v: (r) => r.name }, { h: t("cProjectsCreated"), w: 12, v: (r) => r.projectsCreated },
      { h: t("cContactsCreated"), w: 12, v: (r) => r.contactsCreated }, { h: t("cActions"), w: 10, v: (r) => r.actions },
      { h: t("cRelances"), w: 10, v: (r) => r.relances }, { h: t("cLastActivity"), w: 18, v: (r) => fmtDateTime(r.lastActivityAt) },
    ],
    rows: data.commercials,
  }, 25, 6);

  // ── 3. Projets ──
  h1(t("sProjects"));
  para(`${t("pProjectsInPeriod")} : ${data.projects.total}`);
  para(`${t("noteOwnerAsCreator")} ${t("noteUpdatedBy")}`, { color: GREY });
  const byCreated = [...data.projects.rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const byUpdated = [...data.projects.rows].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  h2(t("sRecentCreated"));
  table({
    columns: [
      { h: t("cProject"), w: 30, v: (r) => r.name }, { h: t("cClient"), w: 22, v: (r) => r.client || "" },
      { h: t("cOwner"), w: 22, v: (r) => r.owner || "" }, { h: t("cCreatedBy"), w: 14, v: () => t("notAvailable") },
      { h: t("cCreatedAt"), w: 16, v: (r) => fmtDate(r.createdAt) }, { h: t("cStatus"), w: 16, v: (r) => r.status || "" },
    ],
    rows: byCreated,
  }, 10, 6);
  h2(t("sRecentModified"));
  table({
    columns: [
      { h: t("cProject"), w: 30, v: (r) => r.name }, { h: t("cOwner"), w: 22, v: (r) => r.owner || "" },
      { h: t("cUpdatedAt"), w: 18, v: (r) => fmtDateTime(r.updatedAt) }, { h: t("cUpdatedBy"), w: 22, v: (r) => r.updatedBy || t("notAvailable") },
      { h: t("cStatus"), w: 16, v: (r) => r.status || "" },
    ],
    rows: byUpdated,
  }, 10, 5);

  // ── 4. Projets archivés ──
  h1(t("sArchived"));
  para(`${t("kProjectsArchived")} : ${data.archived.total}`);
  para(t("noteArchivedBy"), { color: GREY });
  table({
    columns: [
      { h: t("cProject"), w: 30, v: (r) => r.name }, { h: t("cCommercial"), w: 22, v: (r) => r.owner || "" },
      { h: t("cCreatedBy"), w: 14, v: () => t("notAvailable") }, { h: t("cCreatedAt"), w: 16, v: (r) => fmtDate(r.createdAt) },
      { h: t("cArchivedBy"), w: 20, v: (r) => r.archivedBy || t("notAvailable") }, { h: t("cArchivedAt"), w: 16, v: (r) => fmtDate(r.archivedAt) },
    ],
    rows: data.archived.rows,
  }, 25, 6);

  // ── 5. Contacts ──
  h1(t("sContacts"));
  para(`${t("cContactsTotal")} : ${data.overview.kpis.find((k) => k.key === "totalContacts")?.value ?? t("notAvailable")}`);
  h2(t("sContactsByRep"));
  table(tables.contacts, 15, 6);
  h2(t("sRecentContacts"));
  table({
    columns: [
      { h: t("cName"), w: 30, v: (r) => r.name }, { h: t("cStatus"), w: 18, v: (r) => r.statut || "" },
      { h: t("cCreatedBy"), w: 24, v: (r) => r.createdBy || t("notAvailable") }, { h: t("cCreatedAt"), w: 18, v: (r) => fmtDateTime(r.createdAt) },
    ],
    rows: data.contacts.recent,
  }, 10, 4);

  // ── 6/7. PROD 1 et PROD 2 ──
  const prodBlock = (line) => {
    h1(t("sProdLine", { name: line.name }));
    if (line.key === "1") para(t("noteProdDefinition"), { color: GREY });
    kv([
      [t("cTotalSheets"), String(line.total)],
      [t("cFirstSheet"), line.firstAt ? fmtDate(line.firstAt) : t("notAvailable")],
      [t("cLastSheet"), line.lastAt ? fmtDate(line.lastAt) : t("notAvailable")],
      [t("cLastSheetCreated"), line.last ? `${line.last.label} - ${t("cLastSheetBy")} ${line.last.userName || t("notAvailable")} - ${fmtDateTime(line.last.at)}` : t("notAvailable")],
      [t("cSheetsByType"), `${t("typePromesh")}: ${line.byType.promesh} | ${t("typeProbar")}: ${line.byType.probar} | ${t("typeRecuperable")}: ${line.byType.recuperable}`],
    ]);
    h2(t("cSheetsPerUser"));
    table({
      columns: [
        { h: t("cUser"), w: 34, v: (r) => r.name || t("notAvailable") }, { h: t("cFiches"), w: 10, v: (r) => r.fiches },
        { h: t("cFirstCreation"), w: 20, v: (r) => fmtDateTime(r.firstAt) }, { h: t("cLastCreation"), w: 20, v: (r) => fmtDateTime(r.lastAt) },
      ],
      rows: line.perUser,
    }, 20, 4);
    h2(t("cSheetsPerDay"));
    table({
      columns: [{ h: t("cDate"), w: 20, v: (r) => fmtDate(r.date) }, { h: t("cFiches"), w: 12, v: (r) => r.count }],
      rows: line.perDay.filter((d) => d.count > 0),
    }, 31, 2);
  };
  for (const line of data.production.lines) prodBlock(line);

  h2(t("sProdEvolution"));
  table(tables.prodDaily, 31, 4);
  h2(t("sProdUsers"));
  table(tables.prodUsers, 20, 6);

  // ── 8. Machines / industrie ──
  h1(t("sIndustry"));
  para(t("noteWasteSources"), { color: GREY });
  barChart(t("chProductionPerMachine"), data.machines.machines.map((m) => ({ label: `${m.module} ${m.machine}`, value: m.quantity })).filter((x) => x.value > 0));
  table(tables.machines, 20, 8);

  // ── 9. Qualité ──
  h1(t("sQuality"));
  para(t("qDisclaimer"), { color: GREY });
  table(tables.quality, 30, 4);

  // ── 10. Remarques ──
  h1(t("sRemarks"));
  if (data.remarks.length === 0) para(t("rNoRemarks"));
  for (const r of data.remarks) para(`- ${r.text}  [${r.kind === "recorded" ? t("noteRecorded") : t("noteInterpretation")}]`);

  // ── 11. Recommandations ──
  h1(t("sRecommendations"));
  if (data.recommendations.length === 0) para(t("recNone"));
  for (const r of data.recommendations) {
    ensure(70);
    para(`${t("cFinding")}: ${r.finding}`);
    para(`${t("cData")}: ${r.dataText}`);
    para(`${t("cImpact")}: ${r.impact}`);
    para(`${t("cRecommendation")}: ${r.recommendation}`);
    doc.moveDown(0.5);
  }

  // ── Pied de page (toutes les pages sauf la garde) ──
  const range = doc.bufferedPageRange();
  for (let i = range.start + 1; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor(GREY);
    const y = doc.page.height - 30;
    doc.text(safe(`${t("generatedOn")} ${fmtDateTime(new Date())}  |  ${t("analyzedPeriod")}: ${periodLabel(f, t)}`), 40, y, { width: W - 70, lineBreak: false });
    doc.text(safe(`${t("page")} ${i + 1} / ${range.count}`), 40 + W - 70, y, { width: 70, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}

module.exports = { buildExcel, buildPdf };
