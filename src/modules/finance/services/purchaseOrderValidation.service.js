"use strict";

// Décide si l'extraction d'un Bon de Commande est fiable (status EXTRACTED)
// ou doit être marquée NEEDS_REVIEW — jamais d'invention : on ne "corrige"
// pas une valeur douteuse, on la garde telle quelle et on signale le bon
// pour vérification humaine. Même logique qu'invoiceValidation.service.js.

const CONFIDENCE_THRESHOLD = 0.8;
const TOTAL_TOLERANCE_RATIO = 0.02; // 2% — arrondis OCR/normalisation.

function validateExtraction(extraction) {
  const reasons = [];

  if (!extraction.orderNumber?.value) {
    reasons.push("orderNumber_not_detected");
  } else if (extraction.orderNumber.confidence < CONFIDENCE_THRESHOLD) {
    reasons.push("orderNumber_low_confidence");
  }

  if (!extraction.orderDate?.value) {
    reasons.push("orderDate_not_detected");
  }

  const items = extraction.items || [];
  if (!items.length) {
    reasons.push("no_items_detected");
  } else {
    const hasInvalidQuantity = items.some((it) => it.quantity !== undefined && it.quantity !== null && !Number.isFinite(it.quantity));
    if (hasInvalidQuantity) reasons.push("item_quantity_not_numeric");

    const hasInvalidAmount = items.some((it) => it.amountHT !== undefined && it.amountHT !== null && !Number.isFinite(it.amountHT));
    if (hasInvalidAmount) reasons.push("item_amount_not_numeric");
  }

  // Le TOTAL HT imprimé sur le document est prioritaire (jamais recalculé
  // pour remplacer la valeur lue) — cette comparaison ne fait que signaler
  // un écart pour relecture humaine, sans jamais modifier `totalHT`.
  const totalHT = extraction.totalHT?.value;
  if (totalHT !== null && totalHT !== undefined && items.length) {
    const withAmounts = items.filter((it) => Number.isFinite(it.amountHT));
    if (withAmounts.length === items.length && totalHT > 0) {
      const itemsSum = items.reduce((sum, it) => sum + it.amountHT, 0);
      const diff = Math.abs(itemsSum - totalHT) / totalHT;
      if (diff > TOTAL_TOLERANCE_RATIO) reasons.push("total_mismatch");
    }
  }

  return { needsReview: reasons.length > 0, reasons };
}

module.exports = { validateExtraction, CONFIDENCE_THRESHOLD };
