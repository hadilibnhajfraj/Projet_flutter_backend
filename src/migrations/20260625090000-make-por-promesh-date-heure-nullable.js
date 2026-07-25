"use strict";

// Le parcours opérateur PROMESH crée désormais un brouillon avant que
// dateProduction/heureDebut/heureFin soient connus (saisis plus tard à
// l'étape "Informations générales") — ces 3 colonnes ne peuvent donc plus
// être NOT NULL en base. Elles redeviennent obligatoires uniquement au
// verrouillage définitif (POST /:id/validate, validé côté service).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("por_promesh", "dateProduction", {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await queryInterface.changeColumn("por_promesh", "heureDebut", {
      type: Sequelize.TIME,
      allowNull: true,
    });
    await queryInterface.changeColumn("por_promesh", "heureFin", {
      type: Sequelize.TIME,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn("por_promesh", "dateProduction", {
      type: Sequelize.DATEONLY,
      allowNull: false,
    });
    await queryInterface.changeColumn("por_promesh", "heureDebut", {
      type: Sequelize.TIME,
      allowNull: false,
    });
    await queryInterface.changeColumn("por_promesh", "heureFin", {
      type: Sequelize.TIME,
      allowNull: false,
    });
  },
};
