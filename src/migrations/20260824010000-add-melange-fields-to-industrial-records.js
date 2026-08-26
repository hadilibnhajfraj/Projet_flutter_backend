"use strict";

// §MODIFICATION — FICHE MÉLANGE : ajoute les 4 nouveaux champs structurés de
// la Fiche MÉLANGE (heureDebut/heureFin/promesh/echantillon) comme colonnes
// réelles sur la table générique `industrial_records` (déjà partagée par
// PROBAR/MÉLANGE/MAINTENANCE — voir models/IndustrialRecord.js). Nullable au
// niveau DB (comme `melangeData`, `typePanne`, etc.) car spécifiques au
// module MÉLANGE ; le caractère obligatoire est appliqué au niveau
// validation (Joi) + service, pas au niveau colonne, pour ne rien casser
// sur les fiches PROBAR/MAINTENANCE existantes.
//
// Raw ALTER TABLE (pas queryInterface.addColumn) — même convention que les
// autres migrations de ce projet.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "industrial_records"
        ADD COLUMN IF NOT EXISTS "heureDebut" TIME NULL,
        ADD COLUMN IF NOT EXISTS "heureFin" TIME NULL,
        ADD COLUMN IF NOT EXISTS "promesh" VARCHAR(20) NULL,
        ADD COLUMN IF NOT EXISTS "echantillon" VARCHAR(255) NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "industrial_records"
        DROP COLUMN IF EXISTS "heureDebut",
        DROP COLUMN IF EXISTS "heureFin",
        DROP COLUMN IF EXISTS "promesh",
        DROP COLUMN IF EXISTS "echantillon"
    `);
  },
};
