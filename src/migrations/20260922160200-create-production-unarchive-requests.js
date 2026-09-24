"use strict";

// Demandes de désarchivage d'une fiche PROMESH/PROBAR archivée automatiquement
// (brouillon > 2h sans finalisation). Même architecture que
// production_compliance_authorization_requests (module production-compliance) :
// un utilisateur propriétaire d'une fiche ARCHIVED envoie une demande ; un
// responsable (mêmes comptes que le contrôle de production — cfg.managers)
// l'approuve (→ fiche repasse BROUILLON) ou la refuse. Additive uniquement.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "production_unarchive_requests",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          ficheType: { type: Sequelize.STRING(20), allowNull: false },
          ficheId: { type: Sequelize.UUID, allowNull: false },
          userId: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
          userEmail: { type: Sequelize.STRING(255), allowNull: false },
          dateProduction: { type: Sequelize.DATEONLY, allowNull: true },
          machine: { type: Sequelize.STRING(50), allowNull: true },
          poste: { type: Sequelize.STRING(50), allowNull: true },
          ficheCreatedAt: { type: Sequelize.DATE, allowNull: false },
          archivedAt: { type: Sequelize.DATE, allowNull: false },
          reason: { type: Sequelize.TEXT, allowNull: false },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "PENDING" },
          requestedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          reviewedAt: { type: Sequelize.DATE, allowNull: true },
          reviewedBy: { type: Sequelize.UUID, allowNull: true },
          reviewerEmail: { type: Sequelize.STRING(255), allowNull: true },
          reviewNote: { type: Sequelize.TEXT, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE production_unarchive_requests
           ADD CONSTRAINT chk_pur_status CHECK (status IN ('PENDING','APPROVED','REJECTED'))`,
        { transaction }
      );
      // Une seule demande EN ATTENTE par fiche (jamais de doublon — §8-like).
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_pur_pending_per_fiche
           ON production_unarchive_requests ("ficheType", "ficheId")
           WHERE status = 'PENDING'`,
        { transaction }
      );
      await queryInterface.addIndex("production_unarchive_requests", ["status", "requestedAt"], { name: "idx_pur_status", transaction });
      await queryInterface.addIndex("production_unarchive_requests", ["userId"], { name: "idx_pur_user", transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("production_unarchive_requests");
  },
};
