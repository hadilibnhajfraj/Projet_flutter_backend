"use strict";

// Décide si l'extraction d'un Bon de Livraison est fiable (status DRAFT) ou
// doit être marquée NEEDS_REVIEW — même principe que
// invoiceValidation.service.js : jamais d'invention, une donnée douteuse
// reste visible mais signalée pour vérification humaine.

const CONFIDENCE_THRESHOLD = 0.8;
const TOTAL_TOLERANCE_RATIO = 0.02;

function validateExtraction(extraction) {
  const reasons = [];

  if (!extraction.deliveryNumber?.value) {
    reasons.push("deliveryNumber_not_detected");
  } else if (extraction.deliveryNumber.confidence < CONFIDENCE_THRESHOLD) {
    reasons.push("deliveryNumber_low_confidence");
  }

  if (!extraction.deliveryDate?.value) {
    reasons.push("deliveryDate_not_detected");
  } else if (extraction.deliveryDate.confidence < CONFIDENCE_THRESHOLD) {
    reasons.push("deliveryDate_low_confidence");
  }

  const items = extraction.items || [];
  if (!items.length) {
    reasons.push("no_items_detected");
  } else {
    const hasInvalidQuantity = items.some((it) => it.quantity !== undefined && it.quantity !== null && !Number.isFinite(it.quantity));
    if (hasInvalidQuantity) reasons.push("item_quantity_not_numeric");

    const anyLowConfidenceItem = items.some((it) => (it.confidence || 0) < CONFIDENCE_THRESHOLD);
    if (anyLowConfidenceItem) reasons.push("item_low_confidence");

    // Le total du document doit correspondre à la somme des quantités des
    // lignes — un écart signale une extraction douteuse (ex. une ligne
    // ratée), mais on ne remplace JAMAIS silencieusement la valeur du
    // document par la somme calculée : seule la vérification est ajoutée.
    if (extraction.total?.value != null && items.every((it) => Number.isFinite(it.quantity))) {
      const calculatedTotal = items.reduce((sum, it) => sum + it.quantity, 0);
      const documentTotal = extraction.total.value;
      const tolerance = Math.max(0.01, Math.abs(documentTotal) * TOTAL_TOLERANCE_RATIO);
      if (Math.abs(calculatedTotal - documentTotal) > tolerance) reasons.push("total_quantity_mismatch");
    }
  }

  return { needsReview: reasons.length > 0, reasons };
}

module.exports = { validateExtraction, CONFIDENCE_THRESHOLD };
