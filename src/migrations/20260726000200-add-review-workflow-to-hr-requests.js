"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("hr_requests", "ticketNo", {
      type: Sequelize.INTEGER,
      autoIncrement: true,
      allowNull: false,
      unique: true,
    });
    await queryInterface.addColumn("hr_requests", "reviewComment", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("hr_requests", "reviewedBy", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    });
    await queryInterface.addColumn("hr_requests", "reviewedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("hr_requests", "processedBy", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    });
    await queryInterface.addColumn("hr_requests", "processedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("hr_requests", "justificatifs", {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: [],
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("hr_requests", "justificatifs");
    await queryInterface.removeColumn("hr_requests", "processedAt");
    await queryInterface.removeColumn("hr_requests", "processedBy");
    await queryInterface.removeColumn("hr_requests", "reviewedAt");
    await queryInterface.removeColumn("hr_requests", "reviewedBy");
    await queryInterface.removeColumn("hr_requests", "reviewComment");
    await queryInterface.removeColumn("hr_requests", "ticketNo");
  },
};
