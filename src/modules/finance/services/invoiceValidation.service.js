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

  // §MODIFICATION — SCAN / OCR DES FACTURES : SUPPORT DE 2 FORMATS —
  // "Le client est identifié" / "Le matricule fiscal est identifié".
  // Générique aux deux formats : `extraction.customer` porte toujours le
  // même nom de champs (name/taxId), qu'il vienne du bloc "Client" SAGE ou
  // du bloc "Client" fournisseur/NADEC (voir extractSupplierInvoiceFields
  // Positional — jamais rempli avec le nom/matricule du FOURNISSEUR).
  if (!extraction.customer?.name?.value) reasons.push("customer_not_detected");
  if (!extraction.customer?.taxId?.value) reasons.push("customer_taxid_not_detected");

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

  // Total HT + TVA ≈ Total TTC — deuxième contrôle croisé demandé
  // (§VALIDATION). Simple garde-fou : ne DÉCIDE jamais de la valeur finale
  // (toujours la valeur imprimée, jamais recalculée — voir
  // processInvoiceUpload), seulement le statut EXTRACTED/NEEDS_REVIEW. Une
  // petite différence d'arrondi imprimée sur le document lui-même (ex.
  // NADEC : 21 280,000 + 4 043,200 = 25 323,200 imprimé vs 25 324,200 réel)
  // reste sous la tolérance et ne déclenche pas de révision.
  const totalHT = extraction.totals?.subtotalHT?.value;
  const totalTax = extraction.totals?.totalTax?.value;
  const totalTTC = extraction.totals?.totalTTC?.value;
  if (totalHT != null && totalTax != null && totalTTC != null && totalTTC > 0) {
    const expectedTTC = totalHT + totalTax;
    const diff = Math.abs(expectedTTC - totalTTC) / totalTTC;
    if (diff > TOTALS_TOLERANCE_RATIO) reasons.push("ht_tax_ttc_mismatch");
  }

  return { needsReview: reasons.length > 0, reasons };
}

module.exports = { validateExtraction, CONFIDENCE_THRESHOLD };
