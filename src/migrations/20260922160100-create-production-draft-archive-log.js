"use strict";

// Journal d'audit de l'archivage automatique des brouillons PROMESH/PROBAR
// (2h sans finalisation) et de leur désarchivage éventuel — une ligne par
// événement, jamais modifiée après coup sauf pour poser unarchivedAt/
// unarchivedBy lors d'une approbation de désarchivage. Additive uniquement,
// ne touche aucune table existante.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "production_draft_archive_log",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          // "PROMESH" (por_promesh) ou "PROBAR" (industrial_records module='probar').
          ficheType: { type: Sequelize.STRING(20), allowNull: false },
          ficheId: { type: Sequelize.UUID, allowNull: false },
          userId: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
          userEmail: { type: Sequelize.STRING(255), allowNull: false },
          dateProduction: { type: Sequelize.DATEONLY, allowNull: true },
          machine: { type: Sequelize.STRING(50), allowNull: true },
          poste: { type: Sequelize.STRING(50), allowNull: true },
          ficheCreatedAt: { type: Sequelize.DATE, allowNull: false },
          expiresAt: { type: Sequelize.DATE, allowNull: false },
          archivedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          reason: { type: Sequelize.TEXT, allowNull: false },
          action: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "AUTO_ARCHIVED" },
          unarchivedAt: { type: Sequelize.DATE, allowNull: true },
          unarchivedBy: { type: Sequelize.UUID, allowNull: true },
          unarchivedByEmail: { type: Sequelize.STRING(255), allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.addIndex("production_draft_archive_log", ["ficheType", "ficheId"], { name: "idx_pdal_fiche", transaction });
      await queryInterface.addIndex("production_draft_archive_log", ["userId"], { name: "idx_pdal_user", transaction });
      await queryInterface.addIndex("production_draft_archive_log", ["archivedAt"], { name: "idx_pdal_archived_at", transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("production_draft_archive_log");
  },
};
