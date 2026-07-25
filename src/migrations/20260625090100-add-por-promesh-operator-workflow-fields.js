"use strict";

// Champs introduits par le parcours opérateur simplifié (Machine → Poste →
// Informations générales → Rendement / Personnel / Observation / N/C /
// Contrôle Qualité) :
//   - operateur                 : Informations générales (saisi manuellement)
//   - productionM2              : module Rendement (toujours en m², jamais en kg)
//   - conformite + 3 champs     : module N/C (un seul statut par fiche,
//     description/photo/actions correctives uniquement si non_conforme)
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "operateur", {
      type: Sequelize.STRING(255),
      allowNull: true,
    });

    await queryInterface.addColumn("por_promesh", "productionM2", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });

    await queryInterface.addColumn("por_promesh", "conformite", {
      type: Sequelize.ENUM("conforme", "non_conforme"),
      allowNull: true,
    });

    await queryInterface.addColumn("por_promesh", "descriptionNonConformite", {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addColumn("por_promesh", "photoNonConformite", {
      type: Sequelize.STRING(500),
      allowNull: true,
    });

    await queryInterface.addColumn("por_promesh", "actionsCorrectives", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("por_promesh", "actionsCorrectives");
    await queryInterface.removeColumn("por_promesh", "photoNonConformite");
    await queryInterface.removeColumn("por_promesh", "descriptionNonConformite");
    await queryInterface.removeColumn("por_promesh", "conformite");
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_por_promesh_conformite";');
    await queryInterface.removeColumn("por_promesh", "productionM2");
    await queryInterface.removeColumn("por_promesh", "operateur");
  },
};
