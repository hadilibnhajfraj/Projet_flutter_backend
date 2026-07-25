"use strict";

// `auth.routes.js` lit/écrit déjà `user.refreshTokenHash` à 5 endroits
// (signin, refresh, logout, reset-password) mais la colonne n'a jamais été
// créée en base — l'invalidation de session (notamment après un reset de
// mot de passe : "force re-login partout") était donc silencieusement un
// no-op. Cette migration crée la colonne manquante.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "refreshTokenHash", {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "refreshTokenHash");
  },
};
