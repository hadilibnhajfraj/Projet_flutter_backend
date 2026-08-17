"use strict";

// "Upload invoice" simplifié (page Factured shipments) : le modal ne
// collecte plus que des documents — le backend crée automatiquement la
// facture. customerId/invoiceDate deviennent donc optionnels, comme pour
// finance_shipments (migration 20260813000700). Même piège que cette
// dernière : queryInterface.changeColumn() avec un `references` FK n'a
// silencieusement AUCUN EFFET sur la contrainte NOT NULL ici — vérifié en
// base après migration lors de la correction équivalente sur
// finance_shipments. On utilise donc directement des ALTER COLUMN SQL bruts.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE "finance_invoices" ALTER COLUMN "customerId" DROP NOT NULL');
    await queryInterface.sequelize.query('ALTER TABLE "finance_invoices" ALTER COLUMN "invoiceDate" DROP NOT NULL');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE "finance_invoices" ALTER COLUMN "customerId" SET NOT NULL');
    await queryInterface.sequelize.query('ALTER TABLE "finance_invoices" ALTER COLUMN "invoiceDate" SET NOT NULL');
  },
};
