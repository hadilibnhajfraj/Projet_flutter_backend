"use strict";

// Module CONTRÔLE QUALITÉ — la fiche de contrôle appartient à une MACHINE
// (ligne PROMESH / PROBAR + machine, obligatoires) ; la fiche de PRODUCTION
// devient une association OPTIONNELLE.
//
// - quality_controls."productionRecordId" : NOT NULL → NULL autorisé ;
// - quality_controls.reference : nouvelle référence lisible et unique de la
//   fiche qualité (QC-AAAA-NNNNN), attribuée aux contrôles existants par
//   ordre de création (année de création, heure de Tunis) ;
// - index (productionType, machine) : pages et statistiques par machine.
//
// Additive et réversible : aucune donnée supprimée ni modifiée hors
// reference. Le retour arrière refuse de remettre NOT NULL s'il existe des
// fiches sans production (perte d'information).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.changeColumn(
        "quality_controls",
        "productionRecordId",
        { type: Sequelize.UUID, allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        "quality_controls",
        "reference",
        { type: Sequelize.STRING(20), allowNull: true },
        { transaction }
      );
      // Contrôles existants (y compris supprimés logiquement : la référence
      // ne doit jamais être réattribuée).
      await queryInterface.sequelize.query(
        `WITH numbered AS (
           SELECT id,
                  to_char("createdAt" AT TIME ZONE 'Africa/Tunis', 'YYYY') AS y,
                  row_number() OVER (
                    PARTITION BY to_char("createdAt" AT TIME ZONE 'Africa/Tunis', 'YYYY')
                    ORDER BY "createdAt", id
                  ) AS n
             FROM quality_controls
         )
         UPDATE quality_controls q
            SET reference = 'QC-' || numbered.y || '-' || lpad(numbered.n::text, 5, '0')
           FROM numbered
          WHERE numbered.id = q.id`,
        { transaction }
      );
      await queryInterface.changeColumn(
        "quality_controls",
        "reference",
        { type: Sequelize.STRING(20), allowNull: false },
        { transaction }
      );
      await queryInterface.addIndex("quality_controls", ["reference"], {
        name: "uq_quality_controls_reference",
        unique: true,
        transaction,
      });
      await queryInterface.addIndex("quality_controls", ["productionType", "machine"], {
        name: "idx_quality_controls_type_machine",
        transaction,
      });
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await queryInterface.sequelize.query(
        `SELECT count(*)::int AS n FROM quality_controls WHERE "productionRecordId" IS NULL`,
        { transaction }
      );
      if (n > 0) {
        throw new Error(`${n} fiche(s) qualité sans production : retour arrière impossible sans perte d'information`);
      }
      await queryInterface.removeIndex("quality_controls", "idx_quality_controls_type_machine", { transaction });
      await queryInterface.removeIndex("quality_controls", "uq_quality_controls_reference", { transaction });
      await queryInterface.removeColumn("quality_controls", "reference", { transaction });
      await queryInterface.changeColumn(
        "quality_controls",
        "productionRecordId",
        { type: Sequelize.UUID, allowNull: false },
        { transaction }
      );
    });
  },
};
