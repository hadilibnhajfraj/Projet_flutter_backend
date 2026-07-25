"use strict";

// `resetPasswordTokenHash`/`resetPasswordExpiresAt` existent déjà en base
// (colonnes vérifiées via information_schema — probablement créées hors
// migration lors d'une session précédente) ; seul `resetPasswordRequestedAt`
// est réellement manquant (traçabilité de la dernière demande, en
// complément du journal password_reset_logs).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "resetPasswordRequestedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "resetPasswordRequestedAt");
  },
};
