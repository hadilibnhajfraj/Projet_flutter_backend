"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("hr_request_activities", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      requestId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "hr_requests", key: "id" },
        onDelete: "CASCADE",
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      type: { type: Sequelize.STRING(80), allowNull: false },
      message: { type: Sequelize.STRING(500), allowNull: false },
      metadata: { type: Sequelize.JSONB, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("hr_request_activities", ["requestId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("hr_request_activities");
  },
};
