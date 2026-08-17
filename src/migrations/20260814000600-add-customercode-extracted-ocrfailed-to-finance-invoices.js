"use strict";

// "MODIFICATION CRITIQUE — FACTURED SHIPMENTS : LECTURE AUTOMATIQUE DES
// FACTURES" : `customerCode` est un nouveau champ distinct de
// `customerTaxId` — le document porte un seul libellé "C MF" dont la valeur
// brute (ex. "C1836134R") devient `customerCode`, tandis que `customerTaxId`
// dérive de cette même valeur en retirant le préfixe "C" (ex. "1836134R")
// quand aucun libellé "Matricule Fiscal" distinct n'est présent. Le statut
// suit le même schéma que le pipeline Shipment/Bon de Livraison : EXTRACTED
// remplace ISSUED comme état de succès du pipeline OCR (la création
// JSON-only "facture depuis un shipment", elle, garde ISSUED par défaut —
// voir finance.service.js#createInvoice, chemin non-OCR non modifié).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("finance_invoices", "customerCode", { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.sequelize.query(`ALTER TYPE "enum_finance_invoices_status" ADD VALUE IF NOT EXISTS 'EXTRACTED'`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_finance_invoices_status" ADD VALUE IF NOT EXISTS 'OCR_FAILED'`);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_invoices", "customerCode");
  },
};
