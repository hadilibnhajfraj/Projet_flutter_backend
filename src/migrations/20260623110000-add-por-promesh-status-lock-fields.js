"use strict";

// Cycle de vie + verrou définitif d'une fiche POR PROMESH :
//   - status      : 'BROUILLON' (modifiable/supprimable) → 'VALIDE' (figée).
//   - isLocked    : posé uniquement par POST /por-promesh/:id/validate —
//     jamais par le client sur create/update. Tant que la fiche est en
//     BROUILLON, isLocked reste false.
//   - validatedAt : horodatage de la validation définitive (NOW() au moment
//     du passage à VALIDE).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "status", {
      type: Sequelize.ENUM("BROUILLON", "VALIDE"),
      allowNull: false,
      defaultValue: "BROUILLON",
    });

    await queryInterface.addColumn("por_promesh", "isLocked", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.addColumn("por_promesh", "validatedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("por_promesh", "validatedAt");
    await queryInterface.removeColumn("por_promesh", "isLocked");
    await queryInterface.removeColumn("por_promesh", "status");
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_por_promesh_status";');
  },
};
