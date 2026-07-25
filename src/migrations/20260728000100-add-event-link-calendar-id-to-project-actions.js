"use strict";

// Point 7 de la demande : conserver les identifiants Google renvoyés à la
// création/mise à jour, pour permettre un lien "Ouvrir dans Google Calendar"
// et de futures opérations (déplacement, calendrier secondaire).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("project_actions", "googleEventLink", {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
    await queryInterface.addColumn("project_actions", "googleCalendarId", {
      type: Sequelize.STRING(200),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("project_actions", "googleCalendarId");
    await queryInterface.removeColumn("project_actions", "googleEventLink");
  },
};
