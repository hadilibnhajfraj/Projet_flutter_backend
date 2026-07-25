"use strict";

// Support du canal push Google (`events.watch`) pour la synchronisation
// entrante Google -> CRM (Phase B). Voir googleCalendarWatch.service.js.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("google_calendar_accounts", "watchChannelId", {
      type: Sequelize.STRING(200),
      allowNull: true,
    });
    await queryInterface.addColumn("google_calendar_accounts", "watchResourceId", {
      type: Sequelize.STRING(200),
      allowNull: true,
    });
    await queryInterface.addColumn("google_calendar_accounts", "watchExpiration", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    // Secret opaque envoyé à Google (`token`) et revérifié sur chaque appel
    // webhook entrant (header X-Goog-Channel-Token) — jamais exposé au client.
    await queryInterface.addColumn("google_calendar_accounts", "watchToken", {
      type: Sequelize.STRING(200),
      allowNull: true,
    });
    // Jeton de sync incrémentale Google (evite de relister tout le calendrier
    // à chaque notification webhook).
    await queryInterface.addColumn("google_calendar_accounts", "nextSyncToken", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("google_calendar_accounts", "nextSyncToken");
    await queryInterface.removeColumn("google_calendar_accounts", "watchToken");
    await queryInterface.removeColumn("google_calendar_accounts", "watchExpiration");
    await queryInterface.removeColumn("google_calendar_accounts", "watchResourceId");
    await queryInterface.removeColumn("google_calendar_accounts", "watchChannelId");
  },
};
