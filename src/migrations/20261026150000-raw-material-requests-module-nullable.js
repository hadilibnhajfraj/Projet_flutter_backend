"use strict";

// Demande de matières premières saisie dès la connexion : aucun module
// (PROMESH / PROBAR) n'est encore choisi à ce moment-là — module devient
// facultatif. Les demandes existantes gardent leur module.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("raw_material_requests", "module", { type: Sequelize.STRING(20), allowNull: true });
  },

  // Échoue (sans rien supprimer) tant que des demandes faites à la connexion existent.
  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn("raw_material_requests", "module", { type: Sequelize.STRING(20), allowNull: false });
  },
};
