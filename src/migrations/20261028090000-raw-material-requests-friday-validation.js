"use strict";

// Demande de matières premières du vendredi, validée par le responsable
// logistique achats avant 14 h :
//   - échéance de validation (deadlineAt) et date d'envoi de l'alerte de retard ;
//   - auteur, date et motif d'un rejet ;
//   - une seule demande par utilisateur, poste et jour (index unique) ;
//   - statut initial « En attente de validation ».
// Les demandes existantes sont conservées telles quelles (leur statut n'est
// pas modifié, aucune échéance ne leur est attribuée a posteriori).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const add = (col, def) => queryInterface.addColumn("raw_material_requests", col, def, { transaction });
      await add("deadlineAt", { type: Sequelize.DATE, allowNull: true });
      await add("lateNotifiedAt", { type: Sequelize.DATE, allowNull: true });
      await add("rejectedAt", { type: Sequelize.DATE, allowNull: true });
      await add("rejectedBy", { type: Sequelize.UUID, allowNull: true });
      await add("rejectedByEmail", { type: Sequelize.STRING(255), allowNull: true });
      await add("rejectionComment", { type: Sequelize.TEXT, allowNull: true });

      await queryInterface.changeColumn(
        "raw_material_requests",
        "status",
        { type: Sequelize.STRING(30), allowNull: false, defaultValue: "PENDING_VALIDATION" },
        { transaction }
      );
      await queryInterface.changeColumn("raw_material_request_status_histories", "fromStatus", { type: Sequelize.STRING(30), allowNull: true }, { transaction });
      await queryInterface.changeColumn("raw_material_request_status_histories", "toStatus", { type: Sequelize.STRING(30), allowNull: false }, { transaction });

      // Échoue (sans rien modifier) si des doublons existent déjà.
      await queryInterface.addIndex("raw_material_requests", ["userId", "poste", "requestDate"], {
        unique: true,
        name: "raw_material_requests_user_poste_date_uq",
        transaction,
      });
      await queryInterface.addIndex("raw_material_requests", ["status", "deadlineAt"], {
        name: "raw_material_requests_pending_deadline",
        transaction,
      });
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex("raw_material_requests", "raw_material_requests_pending_deadline", { transaction });
      await queryInterface.removeIndex("raw_material_requests", "raw_material_requests_user_poste_date_uq", { transaction });
      // Les demandes en attente redeviennent « Soumise » (statut existant avant cette migration).
      await queryInterface.sequelize.query(`UPDATE raw_material_requests SET status = 'SUBMITTED' WHERE status = 'PENDING_VALIDATION'`, { transaction });
      await queryInterface.sequelize.query(
        `UPDATE raw_material_request_status_histories SET "toStatus" = 'SUBMITTED' WHERE "toStatus" = 'PENDING_VALIDATION'`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `UPDATE raw_material_request_status_histories SET "fromStatus" = 'SUBMITTED' WHERE "fromStatus" = 'PENDING_VALIDATION'`,
        { transaction }
      );
      await queryInterface.changeColumn("raw_material_request_status_histories", "toStatus", { type: Sequelize.STRING(20), allowNull: false }, { transaction });
      await queryInterface.changeColumn("raw_material_request_status_histories", "fromStatus", { type: Sequelize.STRING(20), allowNull: true }, { transaction });
      await queryInterface.changeColumn(
        "raw_material_requests",
        "status",
        { type: Sequelize.STRING(20), allowNull: false, defaultValue: "SUBMITTED" },
        { transaction }
      );
      for (const col of ["rejectionComment", "rejectedByEmail", "rejectedBy", "rejectedAt", "lateNotifiedAt", "deadlineAt"]) {
        await queryInterface.removeColumn("raw_material_requests", col, { transaction });
      }
    });
  },
};
