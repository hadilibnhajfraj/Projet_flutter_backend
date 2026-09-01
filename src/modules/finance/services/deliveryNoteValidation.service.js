"use strict";

// Décide si l'extraction d'un Bon de Livraison est fiable (status DRAFT) ou
// doit être marquée NEEDS_REVIEW — même principe que
// invoiceValidation.service.js : jamais d'invention, une donnée douteuse
// reste visible mais signalée pour vérification humaine.
//
// §CORRECTION — WORKFLOW OCR CUSTOMER SHIPMENTS (2026-08-31) : deux
// vérifications ("deliveryDate_low_confidence" sur la date, et
// "item_low_confidence" sur CHAQUE ligne produit) étaient PLUS STRICTES ici
// que dans purchaseOrderValidation.service.js (Inflow of raw materials, la
// référence explicite du ticket) — orderDate n'y vérifie QUE sa présence
// (jamais sa confiance), et aucune vérification de confiance par ligne
// n'existe pour les Purchase Orders. Conséquence concrète observée : un Bon
// de Livraison correctement extrait (client/adresse/date/2 lignes produit
// avec quantités cohérentes, ocrConfidence global 81%) restait classé
// NEEDS_REVIEW à cause de la SEULE raison "item_low_confidence" — un
// Purchase Order avec une extraction de qualité équivalente aurait, lui,
// été classé EXTRACTED. Les deux vérifications retirées ci-dessous
// n'existent PAS côté Purchase Order — retirées ici pour un statut
// EXTRACTED/NEEDS_REVIEW cohérent entre les deux modules (§"reuse the SAME
// business logic/status transition" du ticket), jamais pour élargir/
// restreindre la logique au-delà de ce qui existe déjà côté Inflow.
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
  }

  const items = extraction.items || [];
  if (!items.length) {
    reasons.push("no_items_detected");
  } else {
    const hasInvalidQuantity = items.some((it) => it.quantity !== undefined && it.quantity !== null && !Number.isFinite(it.quantity));
    if (hasInvalidQuantity) reasons.push("item_quantity_not_numeric");

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
