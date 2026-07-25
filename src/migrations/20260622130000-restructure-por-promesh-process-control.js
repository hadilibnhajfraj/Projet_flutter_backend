"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.renameColumn("por_promesh_process_control", "categorie", "bloc");
    await queryInterface.addColumn("por_promesh_process_control", "corP1", {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh_process_control", "corP2", {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
    await queryInterface.removeColumn("por_promesh_process_control", "conforme");
    await queryInterface.removeColumn("por_promesh_process_control", "observation");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh_process_control", "conforme", {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh_process_control", "observation", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.removeColumn("por_promesh_process_control", "corP2");
    await queryInterface.removeColumn("por_promesh_process_control", "corP1");
    await queryInterface.renameColumn("por_promesh_process_control", "bloc", "categorie");
  },
};
