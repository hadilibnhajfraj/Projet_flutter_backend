"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_payments", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      invoiceId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "finance_invoices", key: "id" },
        onDelete: "CASCADE",
      },
      amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
      paidDate: { type: Sequelize.DATEONLY, allowNull: false },
      method: { type: Sequelize.STRING(100), allowNull: true },
      reference: { type: Sequelize.STRING(150), allowNull: true },
      registeredBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_payments", ["invoiceId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_payments");
  },
};
