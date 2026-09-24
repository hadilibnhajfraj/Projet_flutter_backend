"use strict";

// "Production Follow-up" — suivi des journées de production SANS AUCUNE
// fiche (complémentaire à production_compliance_alerts, laissée inchangée).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "production_follow_up_alerts",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          productionType: { type: Sequelize.STRING(20), allowNull: false },
          productionDate: { type: Sequelize.DATEONLY, allowNull: false },
          userId: { type: Sequelize.UUID, allowNull: true, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "SET NULL" },
          userEmail: { type: Sequelize.STRING(255), allowNull: true },
          sheetsCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "PENDING" },
          emailError: { type: Sequelize.TEXT, allowNull: true },
          emailSentAt: { type: Sequelize.DATE, allowNull: true },
          lastEmailAttemptAt: { type: Sequelize.DATE, allowNull: true },
          retryCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          recipients: { type: Sequelize.JSONB, allowNull: true },
          resolvedAt: { type: Sequelize.DATE, allowNull: true },
          resolvedByFicheType: { type: Sequelize.STRING(20), allowNull: true },
          resolvedByFicheId: { type: Sequelize.UUID, allowNull: true },
          ignoredAt: { type: Sequelize.DATE, allowNull: true },
          ignoredBy: { type: Sequelize.UUID, allowNull: true },
          ignoredReason: { type: Sequelize.TEXT, allowNull: true },
          checkedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      // §11 — une seule anomalie par production + date (idempotence du cron).
      await queryInterface.addIndex("production_follow_up_alerts", ["productionType", "productionDate"], {
        unique: true,
        name: "uq_production_follow_up_alert",
        transaction,
      });
      await queryInterface.addIndex("production_follow_up_alerts", ["status"], { name: "idx_production_follow_up_status", transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE production_follow_up_alerts
           ADD CONSTRAINT chk_production_follow_up_status
           CHECK (status IN ('PENDING','EMAIL_SENT','RESOLVED','IGNORED'))`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("production_follow_up_alerts");
  },
};
