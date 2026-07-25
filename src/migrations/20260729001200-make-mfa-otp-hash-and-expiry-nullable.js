"use strict";

// otpHash/expiresAt étaient NOT NULL (toujours renseignés à la création) —
// rendus nullable pour pouvoir les effacer une fois l'OTP validé (défense en
// profondeur : un hash consommé n'a plus besoin d'exister en base, même
// `consumedAt` suffit à empêcher sa réutilisation — voir mfa.service.js
// `verifyOtp`). Fonctionnellement neutre : `consumedAt IS NOT NULL` exclut
// déjà ces lignes de toute recherche d'OTP actif.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("mfa_otps", "otpHash", {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.changeColumn("mfa_otps", "expiresAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn("mfa_otps", "otpHash", {
      type: Sequelize.STRING(64),
      allowNull: false,
    });
    await queryInterface.changeColumn("mfa_otps", "expiresAt", {
      type: Sequelize.DATE,
      allowNull: false,
    });
  },
};
