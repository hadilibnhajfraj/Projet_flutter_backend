"use strict";

// Workflow de validation des notes de calcul. Purement additif :
//   - calculation_notes : statut (EN_ATTENTE_VALIDATION | VALIDEE | REFUSEE |
//     ANNULEE), validateur (ID utilisateur, figé à la soumission), n° de
//     soumission, décision (auteur, date, commentaire) et annulation (auteur,
//     date, motif). Les notes existantes passent « En attente de validation »
//     (aucune n'a été validée : le workflow n'existait pas).
//   - notifications : note de calcul concernée (+ n° de soumission) et index
//     unique partiel — une seule notification par destinataire, type, note et
//     soumission (aucun doublon en cas de nouvelle tentative).
// Aucune donnée existante n'est supprimée.

const STATUSES = ["EN_ATTENTE_VALIDATION", "VALIDEE", "REFUSEE", "ANNULEE"];

module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      const add = (col, def) => queryInterface.addColumn("calculation_notes", col, def, { transaction: t });
      const userFk = { type: Sequelize.UUID, allowNull: true, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" };
      await add("status", { type: Sequelize.STRING(30), allowNull: false, defaultValue: "EN_ATTENTE_VALIDATION" });
      await add("validatorId", userFk);
      await add("submissionVersion", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 });
      await add("submittedAt", { type: Sequelize.DATE, allowNull: true });
      await add("decidedBy", userFk);
      await add("decidedAt", { type: Sequelize.DATE, allowNull: true });
      await add("decisionComment", { type: Sequelize.TEXT, allowNull: true });
      await add("cancelledBy", userFk);
      await add("cancelledAt", { type: Sequelize.DATE, allowNull: true });
      await add("cancellationReason", { type: Sequelize.TEXT, allowNull: true });
      await queryInterface.sequelize.query(
        `ALTER TABLE calculation_notes ADD CONSTRAINT calculation_notes_status_chk CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(", ")}))`,
        { transaction: t }
      );
      await queryInterface.sequelize.query(`UPDATE calculation_notes SET "submittedAt" = "createdAt" WHERE "submittedAt" IS NULL`, { transaction: t });
      await queryInterface.addIndex("calculation_notes", ["status"], { name: "calculation_notes_status_idx", transaction: t });
      await queryInterface.addIndex("calculation_notes", ["validatorId", "status"], { name: "calculation_notes_validator_status_idx", transaction: t });

      await queryInterface.addColumn("notifications", "calculationNoteId", { type: Sequelize.INTEGER, allowNull: true }, { transaction: t });
      await queryInterface.addColumn("notifications", "calculationNoteVersion", { type: Sequelize.INTEGER, allowNull: true }, { transaction: t });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX notifications_calculation_note_once_uq ON notifications ("userId", type, "calculationNoteId", "calculationNoteVersion") WHERE "calculationNoteId" IS NOT NULL`,
        { transaction: t }
      );
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    // Refusé (sans rien supprimer) dès qu'une décision ou une notification
    // existe : l'historique des décisions ne doit jamais être perdu.
    const [[{ n }]] = await queryInterface.sequelize.query(
      `SELECT (SELECT count(*) FROM calculation_notes WHERE status <> 'EN_ATTENTE_VALIDATION')
            + (SELECT count(*) FROM notifications WHERE "calculationNoteId" IS NOT NULL) AS n`
    );
    if (Number(n) > 0) throw new Error(`${n} décision(s)/notification(s) de notes de calcul : annulation refusée pour préserver la traçabilité.`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS notifications_calculation_note_once_uq`);
    await queryInterface.removeColumn("notifications", "calculationNoteVersion");
    await queryInterface.removeColumn("notifications", "calculationNoteId");
    await queryInterface.sequelize.query(`ALTER TABLE calculation_notes DROP CONSTRAINT IF EXISTS calculation_notes_status_chk`);
    for (const col of ["cancellationReason", "cancelledAt", "cancelledBy", "decisionComment", "decidedAt", "decidedBy", "submittedAt", "submissionVersion", "validatorId", "status"]) {
      await queryInterface.removeColumn("calculation_notes", col);
    }
  },
};
