"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("pipeline_stages", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING(120),
        allowNull: false,
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
      position: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      isDefault: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      isWonStage: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      isLostStage: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      autoCreateAction: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      createdBy: {
        type: Sequelize.UUID,
        allowNull: true,
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
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    // Partial unique index: name unique only among non-deleted rows
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_name_unique
       ON pipeline_stages (name)
       WHERE "deletedAt" IS NULL`
    );

    await queryInterface.addIndex("pipeline_stages", ["position"]);
    await queryInterface.addIndex("pipeline_stages", ["isWonStage"]);
    await queryInterface.addIndex("pipeline_stages", ["isLostStage"]);
    await queryInterface.addIndex("pipeline_stages", ["createdBy"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("pipeline_stages");
  },
};
