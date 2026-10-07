"use strict";

// Module CONTRÔLE QUALITÉ — PARAMÈTRES PHYSIQUES au niveau de la FICHE.
//
// Les paramètres physiques sont indépendants du temps : ils appartiennent à
// la fiche, pas à un relevé. La table existante quality_control_items est
// réutilisée (aucune table en double) :
// - "readingId" renseigné : contrôle d'un relevé ;
// - "readingId" NULL : paramètre physique de la fiche, unique par (fiche,
//   paramètre) — index unique partiel.
//
// Données existantes : les paramètres physiques déjà saisis dans un relevé
// (nombre de bar, dimensions de maille, cotes) sont remontés au niveau de la
// fiche — UNE ligne par fiche et paramètre (celle qui porte une valeur, du
// relevé le plus récent). Aucune ligne n'est supprimée : les éventuels
// doublons d'autres relevés restent en base, attachés à leur relevé.
//
// Retour arrière : les paramètres physiques sont rattachés au premier relevé
// de leur fiche ; refusé si une fiche porte des paramètres physiques sans
// aucun relevé.
const PHYSICAL_KEYS = ["nombre_bar_longueur", "nombre_bar_largeur", "dimensions_maille", "dimensions_cote_1_long", "dimensions_cote_2_long"];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      await q(`ALTER TABLE quality_control_items ALTER COLUMN "readingId" DROP NOT NULL`);
      await q(
        `UPDATE quality_control_items SET "readingId" = NULL
          WHERE id IN (
            SELECT DISTINCT ON (i."qualityControlId", i."parameterKey") i.id
              FROM quality_control_items i
              JOIN quality_control_readings r ON r.id = i."readingId"
             WHERE i."parameterKey" IN (:keys)
             ORDER BY i."qualityControlId", i."parameterKey", (i.value IS NOT NULL) DESC, r.sequence DESC
          )`,
        { keys: PHYSICAL_KEYS }
      );
      await q(
        `CREATE UNIQUE INDEX uq_quality_control_items_fiche_parameter
           ON quality_control_items ("qualityControlId", "parameterKey") WHERE "readingId" IS NULL`
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const [orphans] = await q(
        `SELECT 1 FROM quality_control_items i
          WHERE i."readingId" IS NULL
            AND NOT EXISTS (SELECT 1 FROM quality_control_readings r WHERE r."qualityControlId" = i."qualityControlId")
          LIMIT 1`
      );
      if (orphans.length) throw new Error("Retour arrière impossible : des fiches portent des paramètres physiques sans aucun relevé.");
      await q(`DROP INDEX IF EXISTS uq_quality_control_items_fiche_parameter`);
      // Doublons éventuels laissés dans les relevés par la migration montante.
      await q(
        `DELETE FROM quality_control_items d
          USING quality_control_items f, quality_control_readings r
          WHERE f."readingId" IS NULL AND r."qualityControlId" = f."qualityControlId" AND r.sequence =
                (SELECT MIN(sequence) FROM quality_control_readings WHERE "qualityControlId" = f."qualityControlId")
            AND d."readingId" = r.id AND d."parameterKey" = f."parameterKey"`
      );
      await q(
        `UPDATE quality_control_items i SET "readingId" = r.id
           FROM quality_control_readings r
          WHERE i."readingId" IS NULL AND r."qualityControlId" = i."qualityControlId"
            AND r.sequence = (SELECT MIN(sequence) FROM quality_control_readings WHERE "qualityControlId" = i."qualityControlId")`
      );
      await q(`ALTER TABLE quality_control_items ALTER COLUMN "readingId" SET NOT NULL`);
    });
  },
};
