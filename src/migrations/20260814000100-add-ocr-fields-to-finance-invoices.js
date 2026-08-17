"use strict";

// Lecture automatique des factures (OCR) : la fiche Invoice doit afficher de
// vraies données extraites du document, pas des "—"/0 systématiques. Ces
// colonnes stockent l'instantané client + le résultat structuré de
// l'extraction (jamais un lien dur vers `clients` : le nom/téléphone/adresse
// lus sur une facture ne correspondent pas forcément à un client existant en
// base, customerId reste utilisable séparément pour le flux JSON historique).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("finance_invoices", "reference", { type: Sequelize.STRING(150), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "customerName", { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "customerPhone", { type: Sequelize.STRING(50), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "customerAddress", { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn("finance_invoices", "customerGovernorate", { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "customerTaxId", { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "ocrConfidence", { type: Sequelize.DECIMAL(5, 2), allowNull: true });
    await queryInterface.addColumn("finance_invoices", "ocrExtraction", { type: Sequelize.JSONB, allowNull: true });

    // Enum Postgres — ADD VALUE ne peut pas être annulé (pas de DROP VALUE),
    // même pattern que les migrations d'enum de rôle déjà présentes dans ce
    // projet (ex. 20260622090000-add-responsable-logistique-achat...).
    await queryInterface.sequelize.query(`ALTER TYPE "enum_finance_invoices_status" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW'`);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("finance_invoices", "reference");
    await queryInterface.removeColumn("finance_invoices", "customerName");
    await queryInterface.removeColumn("finance_invoices", "customerPhone");
    await queryInterface.removeColumn("finance_invoices", "customerAddress");
    await queryInterface.removeColumn("finance_invoices", "customerGovernorate");
    await queryInterface.removeColumn("finance_invoices", "customerTaxId");
    await queryInterface.removeColumn("finance_invoices", "ocrConfidence");
    await queryInterface.removeColumn("finance_invoices", "ocrExtraction");
    // NEEDS_REVIEW reste dans le type enum (Postgres ne supporte pas DROP VALUE) — inoffensif.
  },
};
