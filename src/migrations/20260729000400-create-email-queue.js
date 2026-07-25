"use strict";

// File d'attente d'envoi d'email — permet à /auth/forgot-password (et tout
// futur appelant) de ne jamais échouer si le serveur SMTP répond une erreur
// temporaire (ex: Hostinger "451 4.7.1 Ratelimit exceeded", ou "429"). Le
// message est persisté dès la création (avant même la première tentative
// d'envoi), donc récupérable après un redémarrage serveur ou pour un renvoi
// manuel après échec définitif (status FAILED).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("email_queue", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      to: { type: Sequelize.STRING(200), allowNull: false },
      subject: { type: Sequelize.STRING(255), allowNull: false },
      text: { type: Sequelize.TEXT, allowNull: true },
      html: { type: Sequelize.TEXT, allowNull: true },
      // Catégorie fonctionnelle (ex: "password_reset") — pas de FK, juste un
      // repère pour l'audit / un futur écran de renvoi manuel.
      context: { type: Sequelize.STRING(50), allowNull: true },
      meta: { type: Sequelize.JSON, allowNull: true },

      status: {
        type: Sequelize.ENUM("PENDING", "RETRYING", "SENT", "FAILED"),
        allowNull: false,
        defaultValue: "PENDING",
      },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      maxAttempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 5 },
      nextAttemptAt: { type: Sequelize.DATE, allowNull: true },

      lastResponseCode: { type: Sequelize.INTEGER, allowNull: true },
      lastResponse: { type: Sequelize.STRING(500), allowNull: true },
      lastErrorMessage: { type: Sequelize.STRING(500), allowNull: true },
      lastAttemptAt: { type: Sequelize.DATE, allowNull: true },
      sentAt: { type: Sequelize.DATE, allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("email_queue", ["status"]);
    await queryInterface.addIndex("email_queue", ["to", "createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("email_queue");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_email_queue_status"`);
  },
};
