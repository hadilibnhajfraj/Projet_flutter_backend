"use strict";

// Journal des tentatives de réinitialisation de mot de passe (date, ip,
// email, succès/échec) — sert aussi de source de vérité pour la limite
// "3 demandes par heure par utilisateur" (fiable même après redémarrage
// serveur ou plusieurs instances), en complément d'express-rate-limit qui
// gère la limite par IP.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("password_reset_logs", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      email: { type: Sequelize.STRING(200), allowNull: false },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      action: {
        type: Sequelize.ENUM("requested", "validated", "completed"),
        allowNull: false,
      },
      success: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      reason: { type: Sequelize.STRING(64), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("password_reset_logs", ["email", "createdAt"]);
    await queryInterface.addIndex("password_reset_logs", ["ip", "createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("password_reset_logs");
    await queryInterface.sequelize.query(
      `DROP TYPE IF EXISTS "enum_password_reset_logs_action"`
    );
  },
};
