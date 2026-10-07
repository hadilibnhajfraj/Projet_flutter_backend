"use strict";

// Module CONTRÔLE QUALITÉ — association AUTOMATIQUE d'une fiche qualité à la
// fiche de PRODUCTION correspondante. Le contrôleur ne choisit jamais une
// production : le serveur la recherche à partir de
//   ligne (PROMESH | PROBAR) + machine + date de production + poste.
//
// Sources (lues, jamais modifiées) :
// - PROMESH : por_promesh (machine, "dateProduction", poste) ;
// - PROBAR  : industrial_records module = 'probar' (machine, "dateFiche", poste).
// Les fiches ARCHIVÉES (brouillons expirés) ne sont jamais associées.
//
// Correspondance EXACTE uniquement : une seule fiche → associée ; aucune →
// NO_PRODUCTION_SHEET ; plusieurs → MULTIPLE_PRODUCTION_SHEETS (jamais « la
// première »). Dans les deux derniers cas la fiche qualité reste enregistrable
// sans production.

const PorPromesh = require("../../../models/PorPromesh");
const IndustrialRecord = require("../../../models/IndustrialRecord");
const { Op } = require("sequelize");
const logger = require("../../../utils/logger");

const REASON = Object.freeze({
  INCOMPLETE: "INCOMPLETE_CRITERIA",
  NONE: "NO_PRODUCTION_SHEET",
  MULTIPLE: "MULTIPLE_PRODUCTION_SHEETS",
});

// Le contrôle qualité nomme le second poste « soir », les fiches de
// production « nuit » : c'est le même poste (les deux modules n'en ont que
// deux). « nuit » = anciennes fiches qualité copiées d'une production.
const PRODUCTION_POSTE = Object.freeze({ matin: "matin", soir: "nuit", nuit: "nuit" });

// Même numéro lisible que la page « Fiches de production »
// (production-records DTO) : PROMESH-AAAA-NNNNNN / PROBAR-AAAA-XXXXXX.
function ficheNumero(type, row) {
  const year = row.createdAt ? new Date(row.createdAt).getFullYear() : new Date().getFullYear();
  if (type === "PROMESH") return row.sequenceNumber == null ? null : `PROMESH-${year}-${String(row.sequenceNumber).padStart(6, "0")}`;
  return `PROBAR-${year}-${String(row.id).replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

const noMatch = (reason) => ({ matched: false, reason, productionRecordId: null, ficheNumero: null, lot: null, manufacturingOrder: null });

const clean = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

// Colonnes de production lues pour identifier la fabrication contrôlée.
const ATTRIBUTES = Object.freeze({
  PROMESH: ["id", "sequenceNumber", "createdAt", "dateProduction", "diametreMaille2", "lot", "ordreFabrication"],
  PROBAR: ["id", "createdAt", "dateFiche", "description", "lot", "ordreFabrication"],
});

// Diamètre de la fabrication : PROMESH → colonne « diamètre » de la fiche
// (diametreMaille2, voir production-records DTO) ; PROBAR → clé "dia" du
// JSON de la fiche. null si la fiche ne le renseigne pas (rien d'inventé).
function productionDiameter(type, row) {
  if (type === "PROMESH") return clean(row.diametreMaille2);
  const raw = row.description;
  if (!raw || typeof raw !== "string" || !raw.trim().startsWith("{")) return null;
  try {
    return clean(JSON.parse(raw)?.dia);
  } catch (_) {
    return null;
  }
}

const frDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
};

// Identification de la fabrication contrôlée, composée UNIQUEMENT de données
// de la fiche de production : « FAB01 — 28/08/2026 — Ø12 ».
// - référence : ordre de fabrication de la fiche s'il est renseigné, sinon
//   le numéro de la fiche de production ;
// - date de production de la fiche ;
// - diamètre de la fiche (omis s'il n'est pas renseigné).
function fabricationLabel(type, row) {
  const reference = clean(row.ordreFabrication) || ficheNumero(type, row);
  const date = frDate(type === "PROMESH" ? row.dateProduction : row.dateFiche);
  const diameter = productionDiameter(type, row);
  return [reference, date, diameter ? `Ø${diameter}` : null].filter(Boolean).join(" — ") || null;
}

// Lot et identification de la fabrication portés par la fiche de production
// — seules informations de production montrées dans la fiche qualité.
const productionInfo = (type, row) => ({ lot: clean(row.lot), manufacturingOrder: fabricationLabel(type, row) });

// Relecture du lot / de la fabrication d'une fiche déjà associée.
async function readProductionInfo(productionType, productionRecordId, { transaction } = {}) {
  if (!productionRecordId) return { lot: null, manufacturingOrder: null };
  const type = String(productionType).toUpperCase() === "PROMESH" ? "PROMESH" : "PROBAR";
  const Model = type === "PROMESH" ? PorPromesh : IndustrialRecord;
  const row = await Model.findByPk(productionRecordId, { attributes: ATTRIBUTES[type], transaction });
  return row ? productionInfo(type, row) : { lot: null, manufacturingOrder: null };
}

async function findProductionForQualityControl({ productionType, machine, productionDate, poste }, { transaction } = {}) {
  const type = String(productionType || "").toUpperCase();
  const shift = PRODUCTION_POSTE[String(poste || "").toLowerCase()];
  const date = productionDate ? String(productionDate).slice(0, 10) : null;
  const m = machine == null ? "" : String(machine).trim();
  if (!["PROMESH", "PROBAR"].includes(type) || !m || !date || !shift) return noMatch(REASON.INCOMPLETE);

  // limit 2 : suffit à distinguer « une seule » de « plusieurs ».
  const rows =
    type === "PROMESH"
      ? await PorPromesh.findAll({
          where: { machine: m, dateProduction: date, poste: shift, status: { [Op.ne]: "ARCHIVED" } },
          attributes: ATTRIBUTES.PROMESH,
          order: [["createdAt", "ASC"]],
          limit: 2,
          transaction,
        })
      : await IndustrialRecord.findAll({
          where: { module: "probar", machine: m, dateFiche: date, poste: shift, statut: { [Op.ne]: "archivee" } },
          attributes: ATTRIBUTES.PROBAR,
          order: [["createdAt", "ASC"]],
          limit: 2,
          transaction,
        });

  if (rows.length === 0) return noMatch(REASON.NONE);
  if (rows.length > 1) {
    logger.error(`[QUALITY-CONTROL] plusieurs fiches de production pour ${type} machine ${m} ${date} ${shift} — aucune association`);
    return noMatch(REASON.MULTIPLE);
  }
  return { matched: true, reason: null, productionRecordId: rows[0].id, ficheNumero: ficheNumero(type, rows[0]), ...productionInfo(type, rows[0]) };
}

module.exports = { findProductionForQualityControl, readProductionInfo, REASON };
