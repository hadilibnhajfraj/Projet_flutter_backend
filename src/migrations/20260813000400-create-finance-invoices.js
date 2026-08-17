"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_invoices", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      invoiceNumber: { type: Sequelize.STRING(100), allowNull: false, unique: true },
      shipmentId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "finance_shipments", key: "id" },
        onDelete: "SET NULL",
      },
      customerId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "clients", key: "id" },
      },
      invoiceDate: { type: Sequelize.DATEONLY, allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      tax: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      total: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      status: {
        type: Sequelize.ENUM("ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"),
        allowNull: false,
        defaultValue: "ISSUED",
      },
      createdBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("finance_invoices", ["shipmentId"]);
    await queryInterface.addIndex("finance_invoices", ["customerId"]);
    await queryInterface.addIndex("finance_invoices", ["status"]);
    await queryInterface.addIndex("finance_invoices", ["invoiceNumber"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_invoices");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_finance_invoices_status"`);
  },
};
