"use strict";

// Contrôle de conformité PROD 1 / PROD 2 : journal des alertes email et
// autorisations (rattrapage / passage) accordées par les responsables.
// Additive uniquement : aucune table ni donnée existante n'est modifiée.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "production_compliance_alerts",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          productionType: { type: Sequelize.STRING(20), allowNull: false },
          userId: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
          productionDate: { type: Sequelize.DATEONLY, allowNull: false },
          periodStart: { type: Sequelize.DATE, allowNull: false },
          periodEnd: { type: Sequelize.DATE, allowNull: false },
          sheetsCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "pending" },
          attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          emailSentAt: { type: Sequelize.DATE, allowNull: true },
          recipients: { type: Sequelize.JSONB, allowNull: true },
          lastError: { type: Sequelize.TEXT, allowNull: true },
          checkedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      // Une seule alerte par utilisateur + production + date (idempotence).
      await queryInterface.addIndex("production_compliance_alerts", ["userId", "productionType", "productionDate"], {
        unique: true,
        name: "uq_production_compliance_alert",
        transaction,
      });

      await queryInterface.createTable(
        "production_compliance_authorizations",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          userId: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE" },
          productionType: { type: Sequelize.STRING(20), allowNull: false },
          productionDate: { type: Sequelize.DATEONLY, allowNull: false },
          type: { type: Sequelize.STRING(40), allowNull: false },
          authorizedBy: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          authorizedByEmail: { type: Sequelize.STRING(255), allowNull: false },
          authorizedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          expiresAt: { type: Sequelize.DATE, allowNull: true },
          reason: { type: Sequelize.TEXT, allowNull: true },
          revokedAt: { type: Sequelize.DATE, allowNull: true },
          revokedBy: { type: Sequelize.UUID, allowNull: true },
          usedAt: { type: Sequelize.DATE, allowNull: true },
          usedFicheType: { type: Sequelize.STRING(20), allowNull: true },
          usedFicheId: { type: Sequelize.UUID, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.addIndex("production_compliance_authorizations", ["userId", "productionDate", "type"], {
        name: "idx_production_compliance_auth_lookup",
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE production_compliance_authorizations
           ADD CONSTRAINT chk_production_compliance_auth_type
           CHECK (type IN ('BACKFILL_PREVIOUS_PRODUCTION','BYPASS_MISSING_PRODUCTION_DATE'))`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("production_compliance_authorizations");
    await queryInterface.dropTable("production_compliance_alerts");
  },
};
