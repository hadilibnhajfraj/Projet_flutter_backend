"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_documents", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      module: {
        type: Sequelize.ENUM("INFLOW_RAW_MATERIALS", "SHIPMENT", "INVOICE", "PAYMENT"),
        allowNull: false,
      },
      entityId: { type: Sequelize.UUID, allowNull: true },
      originalName: { type: Sequelize.STRING(255), allowNull: false },
      storedFileName: { type: Sequelize.STRING(255), allowNull: false },
      fileUrl: { type: Sequelize.STRING(500), allowNull: false },
      mimeType: { type: Sequelize.STRING(150), allowNull: false },
      fileSize: { type: Sequelize.INTEGER, allowNull: false },
      status: {
        type: Sequelize.ENUM("PENDING", "VALIDATED", "REJECTED"),
        allowNull: false,
        defaultValue: "PENDING",
      },
      uploadedBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_documents", ["module"]);
    await queryInterface.addIndex("finance_documents", ["entityId"]);
    await queryInterface.addIndex("finance_documents", ["uploadedBy"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_documents");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_finance_documents_module"`);
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_finance_documents_status"`);
  },
};
