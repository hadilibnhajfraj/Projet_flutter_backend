"use strict";

// Fonctions PURES de normalisation des valeurs lues sur une facture (OCR ou
// texte PDF) — aucune ne touche la base ni le réseau, testables isolément.
// Toutes retournent `null` (jamais 0/"" inventés) quand la valeur d'entrée
// est vide/illisible.

//   (espace insécable) et   (espace fine insécable) sont les
// séparateurs de milliers habituels des factures françaises/tunisiennes,
// en plus de l'espace normal.
const SPACE_CHARS = "\\s\\u00A0\\u202F";
const STRIP_NON_NUMERIC_RE = new RegExp(`[^\\d.,${SPACE_CHARS}-]`, "g");
const STRIP_SPACES_RE = new RegExp(`[${SPACE_CHARS}]`, "g");

function pad2(n) {
  return String(n).padStart(2, "0");
}

// "2 500" → 2500 · "2.500" (contexte FR) → 2500 · "2 500,50" → 2500.50 ·
// "1.250,50" → 1250.50 · "12.50" (décimal réel) → 12.5 (jamais confondu
// avec un séparateur de milliers : seul un point suivi d'EXACTEMENT 3
// chiffres, ou plusieurs points, est traité comme séparateur de milliers).
function normalizeNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  s = s.replace(STRIP_NON_NUMERIC_RE, "");
  if (!s || !/\d/.test(s)) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  s = s.replace(STRIP_SPACES_RE, "");

  if (hasComma) {
    // Convention française : la virgule est le séparateur décimal, tout
    // point restant est un séparateur de milliers.
    s = s.replace(/\./g, "");
    s = s.replace(",", ".");
  } else if (hasDot) {
    const dotCount = (s.match(/\./g) || []).length;
    const digitsAfterLastDot = s.length - s.lastIndexOf(".") - 1;
    if (dotCount > 1 || digitsAfterLastDot === 3) {
      s = s.replace(/\./g, "");
    }
    // Sinon (1-2 chiffres après le point) : point décimal réel, laissé tel quel.
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// "14/08/2026", "14-08-2026", "14.08.2026" → "2026-08-14". Déjà au format
// ISO ("2026-08-14") → renvoyé tel quel. Date invalide/illisible → null.
function normalizeDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    if (Number(mo) > 12 || Number(mo) < 1 || Number(d) > 31 || Number(d) < 1) return null;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) < 50 ? "20" : "19") + y;
    if (Number(mo) > 12 || Number(mo) < 1 || Number(d) > 31 || Number(d) < 1) return null;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  return null;
}

// "100/100" → "100X100" · "85/50" → "85X50" · "85*50" → "85X50" ·
// "85 x 50" → "85X50" · "85×50" → "85X50".
function normalizeMeshSize(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*[/x×X*]\s*(\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  return `${m[1]}X${m[2]}`.toUpperCase();
}

// "Ø 6" → "6" · "6 mm" → "6".
function normalizeDiameter(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw)
    .replace(/[Øøɸ]/g, "")
    .replace(/mm/gi, "")
    .trim();
  return s || null;
}

// §CORRECTION EXTRACTION — SÉPARATION UNITÉ / DIAMÈTRE : dernier filet de
// sécurité appliqué avant la SAUVEGARDE des lignes Shipment/Invoice (§11
// "sauvegarde si nécessaire") — jamais à la place de l'extraction
// positionnelle existante (qui sépare déjà Unité/Diam./Maille quand le
// document a des colonnes distinctes, voir invoiceFieldExtraction.service.js
// / deliveryNoteFieldExtraction.service.js), seulement pour les cas où
// `unit` arrive malgré tout fusionné ("M² 10", "ML 04", ex. repli texte
// linéaire). Miroir exact de normalizeFinanceUnit() côté Flutter
// (finance_models.dart) — même règle des deux côtés.
const KNOWN_UNITS = new Set(["M²", "M2", "ML", "KG", "LITRE", "L", "TONNE", "PIECE", "PCS", "UNITE", "UNITÉ", "MILLILITRE", "MILLILITR"]);
const MERGED_UNIT_PATTERN = /^([A-Za-zÀ-ÿ²0-9]+)\s+(\d+)$/;

function normalizeUnitAndDiameter(rawUnit, rawDiameter) {
  const unit = rawUnit === null || rawUnit === undefined ? null : String(rawUnit).trim() || null;
  const diameter = rawDiameter === null || rawDiameter === undefined ? null : String(rawDiameter).trim() || null;

  // Déjà séparé (ou pas d'unité du tout) — jamais retouché.
  if (diameter || !unit) return { unit, diameter };

  const match = unit.match(MERGED_UNIT_PATTERN);
  if (match && KNOWN_UNITS.has(match[1].toUpperCase())) {
    // Le diamètre capturé n'est JAMAIS reformaté — "04" reste "04".
    return { unit: match[1], diameter: match[2] };
  }
  return { unit, diameter };
}

module.exports = {
  normalizeNumber,
  normalizeDate,
  normalizeMeshSize,
  normalizeDiameter,
  normalizeUnitAndDiameter,
};
