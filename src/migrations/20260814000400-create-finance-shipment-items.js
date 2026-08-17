"use strict";

// Lignes produit extraites du Bon de Livraison (§ tableau Référence/
// Désignation/Unité/Diam./Maille/Qté) — table dédiée, comme
// finance_invoice_items, PAS le JSONB `finance_shipments.products` existant
// (celui-ci reste réservé aux lignes saisies manuellement par l'ancien
// formulaire complet ; les lignes OCR sont réellement affichées/vérifiées
// une par une, donc une vraie table). Aucun prix/taxe ici : un BL n'en a
// pas, contrairement aux lignes de facture.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_shipment_items", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      shipmentId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "finance_shipments", key: "id" },
        onDelete: "CASCADE",
      },
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      designation: { type: Sequelize.TEXT, allowNull: true },
      unit: { type: Sequelize.STRING(50), allowNull: true },
      diameter: { type: Sequelize.STRING(50), allowNull: true },
      meshSize: { type: Sequelize.STRING(50), allowNull: true },
      quantity: { type: Sequelize.DECIMAL(12, 3), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_shipment_items", ["shipmentId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_shipment_items");
  },
};
