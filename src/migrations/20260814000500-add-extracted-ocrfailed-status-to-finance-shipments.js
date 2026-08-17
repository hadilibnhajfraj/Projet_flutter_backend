"use strict";

// "MODIFICATION CRITIQUE — LECTURE AUTOMATIQUE DU BON DE LIVRAISON" (§Gestion
// des erreurs) : le statut renvoyé par le pipeline OCR doit distinguer un
// échec total de lecture (OCR_FAILED) d'une extraction correcte (EXTRACTED,
// remplace DRAFT comme état de succès) — NEEDS_REVIEW (déjà ajouté) reste
// pour les extractions partielles/incertaines. Les valeurs ENUM Postgres ne
// peuvent pas être retirées (`down` ne les supprime donc pas).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_finance_shipments_status" ADD VALUE IF NOT EXISTS 'EXTRACTED'`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_finance_shipments_status" ADD VALUE IF NOT EXISTS 'OCR_FAILED'`);
  },

  async down() {},
};
