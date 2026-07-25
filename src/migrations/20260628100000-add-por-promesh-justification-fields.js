"use strict";

// Zones "Justification" des sections Contrôle Process et Contrôle Machine
// (formulaire opérateur PROMESH, écran Contrôle Qualité) : chacune a besoin
// de son propre champ texte partagé — `observationsGenerales` (déjà utilisé
// par le module Observation) ne doit plus être détourné pour la
// justification du Contrôle Process.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "justificationControleProcess", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "justificationControleMachine", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("por_promesh", "justificationControleMachine");
    await queryInterface.removeColumn("por_promesh", "justificationControleProcess");
  },
};
