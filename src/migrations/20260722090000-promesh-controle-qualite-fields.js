"use strict";

// Module "Contrôle Qualité" PROMESH — refonte du tableau de mesures :
//   1. `por_promesh_controles_qualite` gagne `heure` (mesure toutes les 3h —
//      06:00/09:00/12:00/15:00/18:00/21:00 par défaut, saisie libre au-delà)
//      et `numeroPlaque` (numéro de plaque, texte libre) ; perd `observation`
//      (supprimée du périmètre de ce tableau, sur demande explicite).
//   2. `por_promesh` (fiche parente) perd `note` (note /10) et
//      `signatureChefEquipe` — écran "Contrôle Qualité" simplifié, ces deux
//      champs ne sont plus saisis nulle part côté front.
// Toute valeur déjà saisie sur les colonnes supprimées est perdue
// (colonnes droppées) — comportement explicitement demandé.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh_controles_qualite", "heure", {
      type: Sequelize.STRING(20),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh_controles_qualite", "numeroPlaque", {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
    await queryInterface.removeColumn("por_promesh_controles_qualite", "observation");

    await queryInterface.removeColumn("por_promesh", "note");
    await queryInterface.removeColumn("por_promesh", "signatureChefEquipe");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "note", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "signatureChefEquipe", {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addColumn("por_promesh_controles_qualite", "observation", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.removeColumn("por_promesh_controles_qualite", "numeroPlaque");
    await queryInterface.removeColumn("por_promesh_controles_qualite", "heure");
  },
};
