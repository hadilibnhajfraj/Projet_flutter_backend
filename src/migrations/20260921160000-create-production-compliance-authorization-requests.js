"use strict";

// Demandes d'autorisation de régularisation PROD 1 / PROD 2 : un utilisateur
// bloqué (fiche d'une date précédente manquante) envoie une demande ; un
// responsable l'approuve (→ autorisation BACKFILL_PREVIOUS_PRODUCTION liée) ou
// la refuse. Additive uniquement.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "production_compliance_authorization_requests",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          userId: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
          userEmail: { type: Sequelize.STRING(255), allowNull: false },
          productionType: { type: Sequelize.STRING(20), allowNull: false },
          missingDate: { type: Sequelize.DATEONLY, allowNull: false },
          requestedDate: { type: Sequelize.DATEONLY, allowNull: false },
          authorizationType: { type: Sequelize.STRING(40), allowNull: false, defaultValue: "BACKFILL_PREVIOUS_PRODUCTION" },
          reason: { type: Sequelize.TEXT, allowNull: true },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "PENDING" },
          requestedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          expiresAt: { type: Sequelize.DATE, allowNull: true },
          reviewedAt: { type: Sequelize.DATE, allowNull: true },
          reviewedBy: { type: Sequelize.UUID, allowNull: true },
          reviewerEmail: { type: Sequelize.STRING(255), allowNull: true },
          reviewNote: { type: Sequelize.TEXT, allowNull: true },
          createdAuthorizationId: { type: Sequelize.UUID, allowNull: true },
          emailStatus: { type: Sequelize.STRING(10), allowNull: false, defaultValue: "PENDING" },
          emailError: { type: Sequelize.TEXT, allowNull: true },
          emailSentAt: { type: Sequelize.DATE, allowNull: true },
          lastEmailAttemptAt: { type: Sequelize.DATE, allowNull: true },
          retryCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE production_compliance_authorization_requests
           ADD CONSTRAINT chk_pc_request_status CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','USED')),
           ADD CONSTRAINT chk_pc_request_email_status CHECK ("emailStatus" IN ('PENDING','SENT','FAILED'))`,
        { transaction }
      );
      // Une seule demande EN ATTENTE par utilisateur + production + date manquante.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_pc_request_pending
           ON production_compliance_authorization_requests ("userId", "productionType", "missingDate")
           WHERE status = 'PENDING'`,
        { transaction }
      );
      await queryInterface.addIndex("production_compliance_authorization_requests", ["status", "requestedAt"], { name: "idx_pc_request_status", transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("production_compliance_authorization_requests");
  },
};
