"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("maintenance_activities", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },
      industrialRecordId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "industrial_records", key: "id" },
        onDelete: "CASCADE",
        onUpdate: "CASCADE",
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
        onUpdate: "CASCADE",
      },
      type: {
        type: Sequelize.STRING(50),
        allowNull: false,
      },
      message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
    });

    await queryInterface.addIndex("maintenance_activities", ["industrialRecordId"]);
    await queryInterface.addIndex("maintenance_activities", ["userId"]);
    await queryInterface.addIndex("maintenance_activities", ["type"]);
    await queryInterface.addIndex("maintenance_activities", ["createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("maintenance_activities");
  },
};
