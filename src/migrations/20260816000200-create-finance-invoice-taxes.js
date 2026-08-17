"use strict";

// Détail des taxes du bloc fiscal (Code/Base/Taux/Taxe) — table dédiée
// (jamais un JSONB), nombre de lignes DYNAMIQUE (jamais supposé à 2 ou 3).
// Même raisonnement que finance_invoice_items : ces lignes sont réellement
// affichées/vérifiées une par une dans la fiche Invoice.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_invoice_taxes", {
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
      code: { type: Sequelize.STRING(20), allowNull: true },
      base: { type: Sequelize.DECIMAL(14, 3), allowNull: true },
      // Taux en % — peut être absent (ex. "TFV" sans taux imprimé), jamais 0
      // inventé.
      rate: { type: Sequelize.DECIMAL(6, 2), allowNull: true },
      amount: { type: Sequelize.DECIMAL(14, 3), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_invoice_taxes", ["invoiceId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_invoice_taxes");
  },
};
