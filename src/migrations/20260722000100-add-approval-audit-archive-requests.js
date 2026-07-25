"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("archive_requests", "approvedBy", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    });
    await queryInterface.addColumn("archive_requests", "approvedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("archive_requests", "rejectedBy", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    });
    await queryInterface.addColumn("archive_requests", "rejectedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("archive_requests", "rejectedAt");
    await queryInterface.removeColumn("archive_requests", "rejectedBy");
    await queryInterface.removeColumn("archive_requests", "approvedAt");
    await queryInterface.removeColumn("archive_requests", "approvedBy");
  },
};
