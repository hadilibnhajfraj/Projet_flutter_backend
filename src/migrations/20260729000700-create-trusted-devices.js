"use strict";

// Appareils de confiance ("Faire confiance à cet appareil pendant 30 jours").
// Seul le HASH du device token (JWT signé, remis en clair au client une seule
// fois) est stocké — jamais la valeur en clair, même logique que les tokens
// de reset password. `deviceId` est l'identifiant stable généré côté client
// (persisté dans flutter_secure_storage) — sert à détecter "nouvel appareil"
// même avant qu'un token de confiance existe. ip/browser/country sont le
// contexte au moment de la confiance accordée — comparés à chaque connexion
// pour révoquer la confiance implicite si l'un d'eux change.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("trusted_devices", {
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
      deviceId: { type: Sequelize.STRING(100), allowNull: false },
      tokenHash: { type: Sequelize.STRING(64), allowNull: false },
      deviceName: { type: Sequelize.STRING(150), allowNull: true },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      browser: { type: Sequelize.STRING(100), allowNull: true },
      country: { type: Sequelize.STRING(2), allowNull: true },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      revokedAt: { type: Sequelize.DATE, allowNull: true },
      lastUsedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("trusted_devices", ["userId", "deviceId"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("trusted_devices");
  },
};
