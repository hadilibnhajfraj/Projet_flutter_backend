"use strict";

// Demandes de matières premières (ISO, RESINE, … FIBRE) saisies avant la création
// d'une fiche de production — voir src/models/RawMaterialRequest.js.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "raw_material_requests",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          userId: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
          userEmail: { type: Sequelize.STRING(255), allowNull: false },
          module: { type: Sequelize.STRING(20), allowNull: false },
          machine: { type: Sequelize.STRING(50), allowNull: true },
          poste: { type: Sequelize.STRING(10), allowNull: false },
          requestDate: { type: Sequelize.DATEONLY, allowNull: false },
          items: { type: Sequelize.JSONB, allowNull: false },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "VALIDATED" },
          clientRequestId: { type: Sequelize.UUID, allowNull: false },
          consumedAt: { type: Sequelize.DATE, allowNull: true },
          ficheType: { type: Sequelize.STRING(20), allowNull: true },
          ficheId: { type: Sequelize.UUID, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.addIndex("raw_material_requests", ["userId", "clientRequestId"], {
        unique: true,
        name: "raw_material_requests_user_client_request_uq",
        transaction,
      });
      await queryInterface.addIndex("raw_material_requests", ["userId", "module", "poste", "consumedAt"], {
        name: "raw_material_requests_pending_lookup",
        transaction,
      });
      await queryInterface.addIndex("raw_material_requests", ["ficheId"], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("raw_material_requests");
  },
};
