"use strict";

// Migration : ajoute la colonne melangeData (JSONB) à industrial_records
// et supprime la limitation de 5000 caractères sur description (devient TEXT sans contrainte).
//
// Compatibilité ascendante garantie :
//   - melangeData est nullable → les anciennes fiches (PROBAR, MAINTENANCE) ne sont pas affectées
//   - description reste présente → les anciennes fiches MÉLANGE qui stockent là restent lisibles
//   - Le code Flutter lira melangeData en priorité, description en fallback

module.exports = {
  async up(queryInterface, Sequelize) {
    // Ajout du champ melangeData
    await queryInterface.addColumn("industrial_records", "melangeData", {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("industrial_records", "melangeData");
  },
};
