"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("por_promesh_attachments", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      porPromeshId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "por_promesh", key: "id" },
        onDelete: "CASCADE",
      },
      uploadedBy: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      fileName: { type: Sequelize.STRING(255), allowNull: false },
      fileUrl: { type: Sequelize.STRING(500), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("por_promesh_attachments", ["porPromeshId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("por_promesh_attachments");
  },
};
