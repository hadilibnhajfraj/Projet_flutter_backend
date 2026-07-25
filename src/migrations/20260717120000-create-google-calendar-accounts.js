"use strict";

// Comptes Google connectés par utilisateur (commercial) — un compte par
// utilisateur (hasOne), tokens chiffrés at rest (voir utils/tokenCrypto.js).
// Permet de créer/mettre à jour/supprimer des événements dans le Google
// Calendar du commercial concerné lors d'un Follow-up.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("google_calendar_accounts", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },

      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },

      googleEmail: { type: Sequelize.STRING(200), allowNull: true },

      // Tokens chiffrés (AES-256-GCM) — jamais stockés en clair.
      accessTokenEnc: { type: Sequelize.TEXT, allowNull: true },
      refreshTokenEnc: { type: Sequelize.TEXT, allowNull: true },
      accessTokenExpiresAt: { type: Sequelize.DATE, allowNull: true },
      scope: { type: Sequelize.STRING(500), allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("google_calendar_accounts", ["userId"], { unique: true });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("google_calendar_accounts");
  },
};
