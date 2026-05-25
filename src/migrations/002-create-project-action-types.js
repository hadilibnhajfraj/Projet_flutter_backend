"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("project_action_types", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING(100),
        allowNull: false,
        unique: true,
      },
      color: {
        type: Sequelize.STRING(20),
        allowNull: true,
        defaultValue: "#6366f1",
      },
      icon: {
        type: Sequelize.STRING(50),
        allowNull: true,
      },
      linkedStageId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "pipeline_stages", key: "id" },
        onDelete: "SET NULL",
        onUpdate: "CASCADE",
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
    });

    await queryInterface.addIndex("project_action_types", ["linkedStageId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("project_action_types");
  },
};
