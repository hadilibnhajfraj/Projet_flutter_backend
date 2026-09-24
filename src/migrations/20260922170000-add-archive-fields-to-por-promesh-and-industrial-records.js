"use strict";

// Ajoute archivedAt/archivedBy/archiveReason/unarchivedAt/unarchivedBy
// DIRECTEMENT sur la fiche (en plus du journal d'audit
// production_draft_archive_log déjà existant, conservé tel quel) — pour un
// affichage direct côté fiche/dashboard sans jointure. Additive uniquement,
// aucune colonne/donnée existante modifiée ou supprimée.
module.exports = {
  async up(queryInterface, Sequelize) {
    for (const table of ["por_promesh", "industrial_records"]) {
      await queryInterface.addColumn(table, "archivedAt", { type: Sequelize.DATE, allowNull: true });
      await queryInterface.addColumn(table, "archivedBy", { type: Sequelize.STRING(255), allowNull: true });
      await queryInterface.addColumn(table, "archiveReason", { type: Sequelize.TEXT, allowNull: true });
      await queryInterface.addColumn(table, "unarchivedAt", { type: Sequelize.DATE, allowNull: true });
      await queryInterface.addColumn(table, "unarchivedBy", { type: Sequelize.STRING(255), allowNull: true });
    }
  },
  async down(queryInterface) {
    for (const table of ["por_promesh", "industrial_records"]) {
      for (const col of ["archivedAt", "archivedBy", "archiveReason", "unarchivedAt", "unarchivedBy"]) {
        await queryInterface.removeColumn(table, col);
      }
    }
  },
};
