"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("finance_shipments", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      reference: { type: Sequelize.STRING(100), allowNull: false, unique: true },
      // clients.id est un INTEGER autoincrement (pas d'UUID) — vérifié en
      // base avant d'écrire cette migration.
      customerId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "clients", key: "id" },
      },
      shipmentDate: { type: Sequelize.DATEONLY, allowNull: false },
      products: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      totalQuantity: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      totalAmount: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      deliveryInfo: { type: Sequelize.TEXT, allowNull: true },
      status: {
        type: Sequelize.ENUM("DRAFT", "PREPARED", "SHIPPED", "DELIVERED", "CANCELLED"),
        allowNull: false,
        defaultValue: "DRAFT",
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

    await queryInterface.addIndex("finance_shipments", ["customerId"]);
    await queryInterface.addIndex("finance_shipments", ["reference"]);
    await queryInterface.addIndex("finance_shipments", ["status"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("finance_shipments");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_finance_shipments_status"`);
  },
};
