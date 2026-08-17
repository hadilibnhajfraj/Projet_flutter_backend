"use strict";

// "New shipment" simplifié : le formulaire ne collecte plus Customer ni
// Shipment date (uniquement "Supporting documents") — le Shipment est
// maintenant créé automatiquement à partir des documents uploadés, donc ces
// deux colonnes doivent devenir optionnelles. Non destructif : on ne fait
// que relâcher une contrainte NOT NULL, aucune donnée existante n'est
// touchée.
// IMPORTANT — queryInterface.changeColumn() avec un `references` FK combiné
// à `allowNull` s'est avéré silencieusement sans effet sur "customerId" sous
// Postgres ici (la commande "migre" sans erreur mais la contrainte NOT NULL
// reste en place — vérifié via information_schema.columns). Des ALTER
// COLUMN SQL bruts, séparés, fonctionnent de façon fiable : on les utilise
// pour les deux colonnes par cohérence/robustesse.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE "finance_shipments" ALTER COLUMN "customerId" DROP NOT NULL');
    await queryInterface.sequelize.query('ALTER TABLE "finance_shipments" ALTER COLUMN "shipmentDate" DROP NOT NULL');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE "finance_shipments" ALTER COLUMN "customerId" SET NOT NULL');
    await queryInterface.sequelize.query('ALTER TABLE "finance_shipments" ALTER COLUMN "shipmentDate" SET NOT NULL');
  },
};
