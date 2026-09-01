"use strict";

// "MODIFICATION DE LA FICHE RECOVERABLES" — ajout d'un second champ
// indépendant "Finished Product (kg)", à ne JAMAIS confondre avec l'ancien
// champ combiné `wasteFinishedProduct` (colonne ajoutée le 2026-08-27, dont
// l'UI "Waste + Finished Product (kg)" a depuis été retirée du formulaire —
// voir le ticket suivant) : `wasteFinishedProduct` reste en base TELLE
// QUELLE (aucune fiche existante modifiée/supprimée), mais son NOM ne
// correspond plus à ce que ce nouveau champ doit représenter (une valeur
// "Finished Product" pure, jamais une somme) — le réutiliser aurait rendu la
// colonne trompeuse pour toujours. `finishedProduct` est donc une colonne
// neuve, au même niveau que `waste` (ajoutée dans la même migration
// précédente), NULL pour toute fiche créée avant ce ticket.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("recuperable_fiches", "finishedProduct", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("recuperable_fiches", "finishedProduct");
  },
};
