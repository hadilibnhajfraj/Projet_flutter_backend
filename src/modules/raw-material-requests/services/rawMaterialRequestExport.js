"use strict";

// Export Excel des demandes de matières premières (menu « Matières
// premières ») — même bibliothèque que les exports Contrôle Qualité
// (exceljs). Une ligne par matière avec ses propres valeurs (jamais de
// total) ; les lignes d'une même demande partagent son numéro.

const ExcelJS = require("exceljs");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

const { STATUS_LABELS } = require("./rawMaterialRequest.service");

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Africa/Tunis";
const HEADER_BLUE = "FF1F3A5F";

const COLUMNS = [
  { header: "N° demande", key: "requestNumber", width: 18 },
  { header: "Date et heure de la demande", key: "createdAt", width: 22 },
  { header: "Demandeur", key: "userEmail", width: 32 },
  { header: "Poste", key: "poste", width: 10 },
  { header: "Date de production", key: "productionDate", width: 16 },
  { header: "Matière première", key: "material", width: 20 },
  { header: "Référence", key: "reference", width: 18 },
  { header: "Lot", key: "lot", width: 16 },
  { header: "Quantité disponible (KG)", key: "quantiteDisponible", width: 16 },
  { header: "Besoin de production (KG)", key: "besoinProduction", width: 16 },
  { header: "Quantité demandée (KG)", key: "quantiteDemandee", width: 16 },
  { header: "Quantité réelle (KG)", key: "quantiteReelle", width: 16 },
  { header: "Unité", key: "unite", width: 8 },
  { header: "Statut", key: "status", width: 22 },
  { header: "Date et heure de validation", key: "validatedAt", width: 22 },
];

// Valeur absente → cellule vide (jamais une chaîne vide ni une valeur inventée).
const dateTime = (v) => (v ? dayjs(v).tz(TZ).format("DD/MM/YYYY HH:mm") : null);
const dateOnly = (v) => (v ? dayjs(v).format("DD/MM/YYYY") : null);
const posteLabel = (p) => (p === "matin" ? "Matin" : p === "nuit" ? "Soir" : p || "");

/** `material` : filtre « Matière première » — seules les lignes de cette matière. */
async function buildRequestsExcel(requests, { material } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM PROBAR";
  const ws = wb.addWorksheet("Matières premières", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS;

  const header = ws.getRow(1);
  header.height = 32;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BLUE } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });

  for (const r of requests) {
    for (const item of (r.items || []).filter((i) => !material || i.material === material)) {
      ws.addRow({
        requestNumber: r.requestNumber,
        createdAt: dateTime(r.createdAt),
        userEmail: r.userEmail,
        poste: posteLabel(r.poste),
        productionDate: dateOnly(r.productionDate),
        material: item.label || item.material,
        reference: item.reference || null,
        lot: item.lot || null,
        quantiteDisponible: item.quantiteDisponible,
        besoinProduction: item.besoinProduction,
        quantiteDemandee: item.quantiteDemandee,
        // Saisie par le shift soir ; cellule vide tant qu'elle n'existe pas.
        quantiteReelle: (r.actualItems || []).find((a) => a.material === item.material)?.quantiteReelle ?? null,
        unite: item.unite || "KG",
        status: STATUS_LABELS[r.status] || r.status,
        validatedAt: dateTime(r.validatedAt),
      });
    }
  }

  const thin = { style: "thin", color: { argb: "FF94A3B8" } };
  ws.eachRow((row) => row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  }));
  for (const key of ["quantiteDisponible", "besoinProduction", "quantiteDemandee", "quantiteReelle"]) {
    ws.getColumn(key).numFmt = "#,##0.###";
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  return wb.xlsx.writeBuffer();
}

module.exports = { buildRequestsExcel, COLUMNS };
