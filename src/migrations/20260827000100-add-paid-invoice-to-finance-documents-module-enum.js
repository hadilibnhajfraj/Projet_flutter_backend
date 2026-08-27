"use strict";

// "MODIFICATION CRM — AJOUTER UN SOUS-MENU IMPORT À CHAQUE MENU FINANCE" :
// le nouveau sous-menu "Import" réutilise le système FinanceDocument/module
// existant (voir la migration OTHER du 2026-08-20) — un document autonome
// (`entityId = NULL`), jamais rattaché à une entité réelle — pour "Inflow of
// raw materials" (module='INFLOW_RAW_MATERIALS'), "Shipment of products"
// (module='SHIPMENT') et "Factured shipments" (module='INVOICE'), les
// valeurs ENUM existantes suffisent déjà (elles servent aussi aux pièces
// jointes des vraies entités OCR — `entityId` non NULL — distinguées par ce
// même champ, jamais mélangées).
//
// "Paid factures" partage la même table `finance_invoices` que "Factured
// shipments" (distingués uniquement côté frontend par un filtre de statut,
// voir FinanceInvoiceTableMode) — sans nouvelle valeur ENUM, ses documents
// "Import" seraient indiscernables de ceux de "Factured shipments"
// (tous deux module='INVOICE', entityId=NULL), ce que le ticket interdit
// explicitement (§15 : "Ne jamais mélanger les données entre les modules").
// 'PAID_INVOICE' est donc ajouté spécifiquement pour ce sous-menu — la seule
// addition ENUM réellement nécessaire pour cette fonctionnalité.
//
// Les valeurs ENUM Postgres ne peuvent pas être retirées (`down` ne la
// supprime donc pas, même limitation que la migration OTHER précédente).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_finance_documents_module" ADD VALUE IF NOT EXISTS 'PAID_INVOICE'`);
  },

  async down() {
    // no-op — voir commentaire ci-dessus.
  },
};
