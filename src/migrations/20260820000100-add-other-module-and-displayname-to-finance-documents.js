"use strict";

// "MODIFICATION — FINANCE > OTHER — SCAN SIMPLE DE DOCUMENTS" : nouveau
// module de stockage documentaire pur (aucune extraction/OCR) réutilisant
// la table `finance_documents` existante plutôt qu'un nouveau système —
// ajoute la valeur ENUM 'OTHER' (jamais rattachée à un Purchase Order/
// Shipment/Invoice/Payment, `entityId` reste NULL pour ce module) et la
// colonne `displayName` (nom modifiable par l'utilisateur, distinct
// d'`originalName` qui reste le nom brut envoyé par le navigateur — voir
// §7/§19 du ticket). Les valeurs ENUM Postgres ne peuvent pas être retirées
// (`down` ne les supprime donc pas).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_finance_documents_module" ADD VALUE IF NOT EXISTS 'OTHER'`);
    await queryInterface.addColumn("finance_documents", "displayName", {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_documents", "displayName");
  },
};
