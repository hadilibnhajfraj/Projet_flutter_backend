"use strict";

// §CORRECTION — WORKFLOW OCR CUSTOMER SHIPMENTS (2026-08-31) : script
// PONCTUEL, à exécuter une seule fois après le correctif de
// deliveryNoteValidation.service.js (retrait de "deliveryDate_low_confidence"
// et "item_low_confidence", deux vérifications plus strictes que
// purchaseOrderValidation.service.js — voir le commentaire en tête de ce
// fichier). Ne touche à aucune donnée extraite/aucun item/aucun calcul :
// relit uniquement le JSONB `ocrExtraction` déjà stocké à l'upload (jamais
// modifié) et RE-EXÉCUTE la même formule de statut déjà utilisée par
// finance.service.js#processShipmentUpload, avec la logique de validation
// désormais corrigée. Un Shipment ne passe à EXTRACTED ici QUE si le
// recalcul le justifie réellement — jamais un flip arbitraire de statut.
//
// Usage : node src/scripts/reclassifyShipmentsAfterValidationFix.js

require("dotenv").config();
const { sequelize } = require("../db");
const FinanceShipment = require("../models/FinanceShipment");
const deliveryNoteValidation = require("../modules/finance/services/deliveryNoteValidation.service");

async function main() {
  const shipments = await FinanceShipment.findAll({
    where: { status: ["NEEDS_REVIEW", "OCR_FAILED"] },
  });

  console.log(`${shipments.length} shipment(s) à réévaluer.`);

  for (const shipment of shipments) {
    const extraction = shipment.ocrExtraction;
    if (!extraction) {
      console.log(`- ${shipment.shipmentNumber} : aucun ocrExtraction stocké, ignoré.`);
      continue;
    }

    // Même calcul que processShipmentUpload — reconstruit depuis les
    // champs déjà stockés dans ocrExtraction (engine/rawText), jamais
    // recalculé différemment.
    const ocrFailed = extraction.engine === "none" || !extraction.rawText || !extraction.rawText.trim();
    const { needsReview, reasons } = deliveryNoteValidation.validateExtraction(extraction);
    const hasReliableDeliveryNumber =
      Boolean(extraction.deliveryNumber?.value) &&
      extraction.deliveryNumber?.confidence >= deliveryNoteValidation.CONFIDENCE_THRESHOLD;
    const newStatus = ocrFailed ? "OCR_FAILED" : needsReview || !hasReliableDeliveryNumber ? "NEEDS_REVIEW" : "EXTRACTED";

    const oldStatus = shipment.status; // capturé AVANT update() — l'instance est mutée en place ensuite.
    if (newStatus === oldStatus) {
      console.log(`- ${shipment.shipmentNumber} : reste ${oldStatus} (raisons=${reasons.join(",") || "aucune"}).`);
      continue;
    }

    await shipment.update({
      status: newStatus,
      ocrExtraction: { ...extraction, validation: { needsReview, reasons } },
    });
    console.log(`- ${shipment.shipmentNumber} : ${oldStatus} → ${newStatus} (raisons restantes=${reasons.join(",") || "aucune"}).`);
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
