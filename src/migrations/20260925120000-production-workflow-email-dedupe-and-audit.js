"use strict";

// Workflow des demandes Production (responsable logistique) :
//
// 1) email_queue."dedupeKey" (UNIQUE, nullable) — clé d'idempotence : une
//    même demande ne peut créer qu'UNE ligne d'email par destinataire, quel
//    que soit le nombre d'appels (refresh, polling, reconnexion, cron rejoué).
//    NULL pour tous les emails existants (MFA, reset password...) : leur
//    comportement est inchangé (Postgres autorise plusieurs NULL en UNIQUE).
//
// 2) production_request_audit_log — journal APPEND-ONLY des actions des
//    responsables sur les demandes (consultation, approbation, refus) :
//    utilisateur, email, date/heure, action, demande, ancienne/nouvelle valeur.
//    Jamais mis à jour ni supprimé par l'application.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn("email_queue", "dedupeKey", { type: Sequelize.STRING(200), allowNull: true }, { transaction });
      await queryInterface.addIndex("email_queue", ["dedupeKey"], { unique: true, name: "uq_email_queue_dedupe_key", transaction });

      await queryInterface.createTable(
        "production_request_audit_log",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          userId: { type: Sequelize.UUID, allowNull: true },
          userEmail: { type: Sequelize.STRING(255), allowNull: true },
          // VIEW | VIEW_HISTORY | VIEW_STATISTICS | APPROVE | REJECT
          action: { type: Sequelize.STRING(30), allowNull: false },
          // AUTHORIZATION | UNARCHIVE | null (vue globale)
          requestType: { type: Sequelize.STRING(20), allowNull: true },
          requestId: { type: Sequelize.UUID, allowNull: true },
          oldValue: { type: Sequelize.TEXT, allowNull: true },
          newValue: { type: Sequelize.TEXT, allowNull: true },
          // SUCCESS | DENIED | FAILED — une tentative refusée est aussi tracée.
          outcome: { type: Sequelize.STRING(10), allowNull: false, defaultValue: "SUCCESS" },
          httpStatus: { type: Sequelize.INTEGER, allowNull: true },
          details: { type: Sequelize.JSONB, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.addIndex("production_request_audit_log", ["requestType", "requestId"], { name: "idx_production_request_audit_request", transaction });
      await queryInterface.addIndex("production_request_audit_log", ["userId", "createdAt"], { name: "idx_production_request_audit_user", transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("production_request_audit_log", { transaction });
      await queryInterface.removeIndex("email_queue", "uq_email_queue_dedupe_key", { transaction });
      await queryInterface.removeColumn("email_queue", "dedupeKey", { transaction });
    });
  },
};
