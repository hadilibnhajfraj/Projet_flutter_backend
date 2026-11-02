"use strict";

// Notes de calcul : affectation à un utilisateur CRM responsable. Purement
// additif — colonnes nullable (une note peut ne pas être affectée), aucune
// donnée existante modifiée.
//   assignedToUserId / assignedAt / assignedByUserId : affectation courante ;
//   assignmentVersion : n° de l'affectation (0 = jamais affectée), sert à ne
//     notifier qu'une fois chaque affectation (index unique des notifications).
// L'historique des affectations est conservé dans calculation_note_histories.
module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      const userFk = { type: Sequelize.UUID, allowNull: true, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" };
      await queryInterface.addColumn("calculation_notes", "assignedToUserId", userFk, { transaction: t });
      await queryInterface.addColumn("calculation_notes", "assignedAt", { type: Sequelize.DATE, allowNull: true }, { transaction: t });
      await queryInterface.addColumn("calculation_notes", "assignedByUserId", userFk, { transaction: t });
      await queryInterface.addColumn("calculation_notes", "assignmentVersion", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 }, { transaction: t });
      await queryInterface.addIndex("calculation_notes", ["assignedToUserId"], { name: "calculation_notes_assigned_to_idx", transaction: t });
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    // Refusé (sans rien supprimer) si une affectation a déjà eu lieu.
    const [[{ n }]] = await queryInterface.sequelize.query(`SELECT count(*)::int AS n FROM calculation_notes WHERE "assignmentVersion" > 0`);
    if (n > 0) throw new Error(`${n} note(s) affectée(s) : annulation refusée pour préserver l'historique des affectations.`);
    await queryInterface.removeIndex("calculation_notes", "calculation_notes_assigned_to_idx");
    for (const col of ["assignmentVersion", "assignedByUserId", "assignedAt", "assignedToUserId"]) {
      await queryInterface.removeColumn("calculation_notes", col);
    }
  },
};
