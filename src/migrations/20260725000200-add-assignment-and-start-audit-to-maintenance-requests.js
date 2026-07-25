"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("maintenance_requests", "assignedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("maintenance_requests", "assignedBy", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    });
    await queryInterface.addColumn("maintenance_requests", "startedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("maintenance_requests", "startedBy", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("maintenance_requests", "startedBy");
    await queryInterface.removeColumn("maintenance_requests", "startedAt");
    await queryInterface.removeColumn("maintenance_requests", "assignedBy");
    await queryInterface.removeColumn("maintenance_requests", "assignedAt");
  },
};
