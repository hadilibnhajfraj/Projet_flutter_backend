"use strict";

// Abstraction "lecture du Bon de Livraison" demandée explicitement par le
// cahier des charges (extractDeliveryNoteData(filePath)). Le moteur brut
// (PDF texte natif / rendu image / OCR Tesseract) est strictement le même
// pour une facture ou un Bon de Livraison — aucune logique spécifique au
// type de document, uniquement de l'extraction texte+mots positionnés — on
// réutilise donc invoiceOcr.service.js plutôt que de dupliquer tout le
// pipeline PDF/OCR. Seule l'INTERPRÉTATION du texte diffère (voir
// deliveryNoteFieldExtraction.service.js) : c'est ce qui justifie un point
// d'entrée nommé séparément, comme demandé.

const invoiceOcr = require("./invoiceOcr.service");

// { filePath, mimeType, originalName } → { pages, fullText, engine }
function extractDeliveryNoteData({ filePath, mimeType, originalName }) {
  return invoiceOcr.extractDocumentText({ filePath, mimeType, originalName, logTag: "DELIVERY OCR" });
}

module.exports = { extractDeliveryNoteData };
