"use strict";

// Module CONTRÔLE QUALITÉ — étapes des relevés + lot / ordre de fabrication
// récupérés de la fiche de production.
//
// 1. quality_control_readings.sequence : rang de l'étape dans la fiche
//    (1, 2, 3… = dernier rang + 1), unique par fiche. L'heure n'identifie
//    jamais un relevé. Relevés existants : numérotés par heure puis création.
// 2. por_promesh / industrial_records : colonnes « lot » et
//    « ordreFabrication » (NULL par défaut) — source du lot et de l'ordre de
//    fabrication affichés automatiquement dans la fiche qualité. Aucune
//    donnée existante modifiée.
// 3. quality_controls."lotAuto" / "manufacturingOrderAuto" : la valeur vient
//    de la fiche de production (lecture seule) et non d'une saisie.
//
// Additive et réversible.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const text = { type: Sequelize.STRING(100), allowNull: true };
      const flag = { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false };

      await queryInterface.addColumn("quality_control_readings", "sequence", { type: Sequelize.INTEGER, allowNull: true }, { transaction });
      await q(`
        UPDATE quality_control_readings r SET sequence = n.rank
          FROM (SELECT id, row_number() OVER (PARTITION BY "qualityControlId" ORDER BY "readingTime", "createdAt", id) AS rank
                  FROM quality_control_readings) n
         WHERE n.id = r.id
      `);
      await q(`ALTER TABLE quality_control_readings ALTER COLUMN sequence SET NOT NULL`);
      await q(`CREATE UNIQUE INDEX uq_quality_control_readings_sequence ON quality_control_readings ("qualityControlId", sequence)`);

      for (const table of ["por_promesh", "industrial_records"]) {
        await queryInterface.addColumn(table, "lot", text, { transaction });
        await queryInterface.addColumn(table, "ordreFabrication", text, { transaction });
      }

      await queryInterface.addColumn("quality_controls", "lotAuto", flag, { transaction });
      await queryInterface.addColumn("quality_controls", "manufacturingOrderAuto", flag, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn("quality_controls", "manufacturingOrderAuto", { transaction });
      await queryInterface.removeColumn("quality_controls", "lotAuto", { transaction });
      for (const table of ["industrial_records", "por_promesh"]) {
        await queryInterface.removeColumn(table, "ordreFabrication", { transaction });
        await queryInterface.removeColumn(table, "lot", { transaction });
      }
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS uq_quality_control_readings_sequence`, { transaction });
      await queryInterface.removeColumn("quality_control_readings", "sequence", { transaction });
    });
  },
};
