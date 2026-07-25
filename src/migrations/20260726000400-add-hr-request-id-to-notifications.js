"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("notifications", "hrRequestId", {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await queryInterface.addIndex("notifications", ["hrRequestId"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("notifications", ["hrRequestId"]);
    await queryInterface.removeColumn("notifications", "hrRequestId");
  },
};
