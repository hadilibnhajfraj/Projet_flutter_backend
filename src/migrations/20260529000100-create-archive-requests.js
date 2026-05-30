"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("archive_requests", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      projectId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "projects", key: "id" },
        onDelete: "CASCADE",
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      adminId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      status: {
        type: Sequelize.ENUM("pending", "approved", "rejected"),
        allowNull: false,
        defaultValue: "pending",
      },
      subject: { type: Sequelize.TEXT, allowNull: false },
      message: { type: Sequelize.TEXT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable("archive_request_messages", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      requestId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "archive_requests", key: "id" },
        onDelete: "CASCADE",
      },
      senderId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      message: { type: Sequelize.TEXT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("archive_requests", ["projectId"]);
    await queryInterface.addIndex("archive_requests", ["userId"]);
    await queryInterface.addIndex("archive_requests", ["status"]);
    await queryInterface.addIndex("archive_request_messages", ["requestId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("archive_request_messages");
    await queryInterface.dropTable("archive_requests");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_archive_requests_status"`);
  },
};
