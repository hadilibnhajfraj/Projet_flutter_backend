"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("maintenance_requests", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      ticketNo: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        allowNull: false,
        unique: true,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      equipement: { type: Sequelize.STRING(200), allowNull: false },
      typePanne: { type: Sequelize.STRING(200), allowNull: false },
      urgence: {
        type: Sequelize.ENUM("faible", "moyenne", "critique"),
        allowNull: false,
        defaultValue: "moyenne",
      },
      description: { type: Sequelize.TEXT, allowNull: true },
      photos: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      statut: {
        type: Sequelize.ENUM("en_attente", "acceptee", "refusee", "terminee"),
        allowNull: false,
        defaultValue: "en_attente",
      },
      technicianId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      acceptedBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      rejectedBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      completedBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      rejectionReason: { type: Sequelize.TEXT, allowNull: true },
      processedAt: { type: Sequelize.DATE, allowNull: true },
      completedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable("maintenance_request_comments", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      requestId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "maintenance_requests", key: "id" },
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
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable("maintenance_request_activities", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      requestId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "maintenance_requests", key: "id" },
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

    await queryInterface.addIndex("maintenance_requests", ["userId"]);
    await queryInterface.addIndex("maintenance_requests", ["statut"]);
    await queryInterface.addIndex("maintenance_requests", ["urgence"]);
    await queryInterface.addIndex("maintenance_requests", ["technicianId"]);
    await queryInterface.addIndex("maintenance_request_comments", ["requestId"]);
    await queryInterface.addIndex("maintenance_request_activities", ["requestId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("maintenance_request_activities");
    await queryInterface.dropTable("maintenance_request_comments");
    await queryInterface.dropTable("maintenance_requests");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_maintenance_requests_urgence"`);
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_maintenance_requests_statut"`);
  },
};
