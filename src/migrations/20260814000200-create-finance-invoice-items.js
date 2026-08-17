"use strict";

// Lignes de facture extraites par OCR (§ tableau Référence/Désignation/
// Unité/Diamètre/Maille/Qté/P.U HT/Rms/Montant HT/Taxe1/Taxe2). Table
// dédiée (jamais un JSONB) car ces lignes sont réellement affichées/
// vérifiées une par une dans la fiche Invoice — contrairement à
// FinanceShipment.products qui reste un JSONB de formulaire jamais requêté
// indépendamment. Toutes les colonnes nullable : ne jamais inventer 0/"".
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_invoice_items", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      invoiceId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "finance_invoices", key: "id" },
        onDelete: "CASCADE",
      },
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      designation: { type: Sequelize.TEXT, allowNull: true },
      unit: { type: Sequelize.STRING(50), allowNull: true },
      // Texte, pas numérique : une valeur OCR comme "Ø 6" se normalise en la
      // chaîne "6", ce n'est pas une quantité calculable.
      diameter: { type: Sequelize.STRING(50), allowNull: true },
      meshSize: { type: Sequelize.STRING(50), allowNull: true },
      quantity: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      unitPriceHT: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
      rms: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      amountHT: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
      tax1: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
      tax2: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_invoice_items", ["invoiceId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_invoice_items");
  },
};
