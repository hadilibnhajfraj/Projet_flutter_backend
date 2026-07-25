"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "machine", {
      type: Sequelize.STRING(10),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "poste", {
      type: Sequelize.ENUM("matin", "nuit"),
      allowNull: true,
    });
    await queryInterface.addIndex("por_promesh", ["machine"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("por_promesh", ["machine"]);
    await queryInterface.removeColumn("por_promesh", "poste");
    await queryInterface.removeColumn("por_promesh", "machine");
  },
};
