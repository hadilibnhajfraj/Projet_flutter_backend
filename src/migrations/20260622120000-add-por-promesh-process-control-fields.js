"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "observationsGenerales", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "visaResponsableLogistiqueProcess", {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "visaControleQualiteProcess", {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "visaProductionProcess", {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "dateValidationProcess", {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("por_promesh", "dateValidationProcess");
    await queryInterface.removeColumn("por_promesh", "visaProductionProcess");
    await queryInterface.removeColumn("por_promesh", "visaControleQualiteProcess");
    await queryInterface.removeColumn("por_promesh", "visaResponsableLogistiqueProcess");
    await queryInterface.removeColumn("por_promesh", "observationsGenerales");
  },
};
