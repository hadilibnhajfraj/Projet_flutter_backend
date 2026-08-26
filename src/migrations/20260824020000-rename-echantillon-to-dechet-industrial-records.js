"use strict";

// §MODIFICATION — FICHE MÉLANGE (simplification) : renomme la colonne
// "echantillon" en "dechet" sur `industrial_records`. Un RENAME (pas un
// drop+add) — préserve les valeurs déjà enregistrées sur les fiches
// MÉLANGE existantes (§ "Ne pas casser les fiches Mélange existantes").

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "industrial_records" RENAME COLUMN "echantillon" TO "dechet"
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "industrial_records" RENAME COLUMN "dechet" TO "echantillon"
    `);
  },
};
