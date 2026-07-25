"use strict";

// OTP MFA — un utilisateur peut avoir plusieurs lignes historiques (une
// nouvelle demande invalide l'ancienne, même logique que resetPasswordTokenHash
// mais avec un historique conservé pour l'audit plutôt qu'un simple champ sur
// users). Seul le HASH de l'OTP est stocké (jamais la valeur en clair).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("mfa_otps", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      otpHash: { type: Sequelize.STRING(64), allowNull: false },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      consumedAt: { type: Sequelize.DATE, allowNull: true },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      maxAttempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 5 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("mfa_otps", ["userId", "createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("mfa_otps");
  },
};
