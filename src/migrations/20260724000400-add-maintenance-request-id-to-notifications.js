"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("notifications", "maintenanceRequestId", {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await queryInterface.addIndex("notifications", ["maintenanceRequestId"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("notifications", ["maintenanceRequestId"]);
    await queryInterface.removeColumn("notifications", "maintenanceRequestId");
  },
};
