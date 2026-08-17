"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_activities", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      entityType: { type: Sequelize.STRING(40), allowNull: false },
      entityId: { type: Sequelize.UUID, allowNull: false },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      type: { type: Sequelize.STRING(50), allowNull: false },
      message: { type: Sequelize.STRING(500), allowNull: false },
      metadata: { type: Sequelize.JSONB, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_activities", ["entityType", "entityId"]);
    await queryInterface.addIndex("finance_activities", ["userId"]);
    await queryInterface.addIndex("finance_activities", ["type"]);
    await queryInterface.addIndex("finance_activities", ["createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_activities");
  },
};
