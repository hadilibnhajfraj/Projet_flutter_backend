"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("projects", "productFamily", {
      type: Sequelize.ENUM("PROBAR", "PROMESH"),
      allowNull: true,
    });
    await queryInterface.addColumn("projects", "diameterMm", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addIndex("projects", ["productFamily"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("projects", ["productFamily"]);
    await queryInterface.removeColumn("projects", "diameterMm");
    await queryInterface.removeColumn("projects", "productFamily");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_projects_productFamily"`);
  },
};
