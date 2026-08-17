"use strict";

// Décide si une extraction est fiable (status ISSUED) ou doit être marquée
// NEEDS_REVIEW — jamais d'invention : on ne "corrige" pas une valeur
// douteuse, on la garde telle quelle et on signale la facture pour
// vérification humaine.

const CONFIDENCE_THRESHOLD = 0.8;
const TOTALS_TOLERANCE_RATIO = 0.02; // 2% — arrondis OCR/normalisation.

function validateExtraction(extraction) {
  const reasons = [];

  if (!extraction.invoiceNumber?.value) {
    reasons.push("invoiceNumber_not_detected");
  } else if (extraction.invoiceNumber.confidence < CONFIDENCE_THRESHOLD) {
    reasons.push("invoiceNumber_low_confidence");
  }

  if (!extraction.invoiceDate?.value) {
    reasons.push("invoiceDate_not_detected");
  } else if (extraction.invoiceDate.confidence < CONFIDENCE_THRESHOLD) {
    reasons.push("invoiceDate_low_confidence");
  }

  const items = extraction.items || [];
  if (!items.length) {
    reasons.push("no_items_detected");
  } else {
    const hasInvalidQuantity = items.some((it) => it.quantity !== undefined && it.quantity !== null && !Number.isFinite(it.quantity));
    if (hasInvalidQuantity) reasons.push("item_quantity_not_numeric");

    const hasInvalidAmount = items.some((it) => it.amountHT !== undefined && it.amountHT !== null && !Number.isFinite(it.amountHT));
    if (hasInvalidAmount) reasons.push("item_amount_not_numeric");

    const anyLowConfidenceItem = items.some((it) => (it.confidence || 0) < CONFIDENCE_THRESHOLD);
    if (anyLowConfidenceItem) reasons.push("item_low_confidence");
  }

  const subtotal = extraction.totals?.subtotalHT?.value;
  if (subtotal !== null && subtotal !== undefined && items.length) {
    const itemsSum = items.reduce((sum, it) => sum + (Number.isFinite(it.amountHT) ? it.amountHT : 0), 0);
    const withAmounts = items.filter((it) => Number.isFinite(it.amountHT));
    if (withAmounts.length === items.length && subtotal > 0) {
      const diff = Math.abs(itemsSum - subtotal) / subtotal;
      if (diff > TOTALS_TOLERANCE_RATIO) reasons.push("totals_mismatch");
    }
  }

  return { needsReview: reasons.length > 0, reasons };
}

module.exports = { validateExtraction, CONFIDENCE_THRESHOLD };
