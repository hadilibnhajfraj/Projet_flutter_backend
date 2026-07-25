"use strict";

// Module "Contrôle Qualité" PROMESH — suppression complète du champ
// "Hauteur" du tableau de mesures. Toute valeur déjà saisie est perdue
// (colonne droppée) — comportement explicitement demandé. Nouvel ordre du
// tableau côté front : Heure, Numéro de plaque, Maille, Longueur, Largeur,
// Conforme, Non conforme.
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn("por_promesh_controles_qualite", "hauteur");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh_controles_qualite", "hauteur", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
  },
};
