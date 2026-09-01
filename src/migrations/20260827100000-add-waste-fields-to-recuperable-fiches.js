"use strict";

// "MODIFICATION DE LA FICHE RECOVERABLES PROCESSED" — simplification de la
// saisie : suppression du tableau par diamètre (Ø6-Ø28, table
// `recuperable_lignes`) au profit de DEUX champs directs sur la fiche,
// `waste` et `wasteFinishedProduct` (kg), noms EXACTS demandés par le
// ticket.
//
// Additive uniquement : les anciennes fiches (et leurs `recuperable_lignes`
// existantes) ne sont ni supprimées ni modifiées — `waste`/
// `wasteFinishedProduct` restent NULL pour elles, l'historique/le détail
// continuent de les afficher via `recuperables` (voir recuperable.dto.js,
// inchangé). Seules les NOUVELLES fiches renseignent ces deux colonnes.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("recuperable_fiches", "waste", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
    await queryInterface.addColumn("recuperable_fiches", "wasteFinishedProduct", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("recuperable_fiches", "waste");
    await queryInterface.removeColumn("recuperable_fiches", "wasteFinishedProduct");
  },
};
