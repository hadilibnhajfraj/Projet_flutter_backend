"use strict";

// Colonnes de synchronisation calendrier CRM / Google Calendar pour les
// actions Timeline — miroir exact des colonnes déjà utilisées par
// CommercialContactRelance (voir followupAutomation.service.js) pour que
// le même pattern d'orchestration soit réutilisable tel quel.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("project_actions", "priorite", {
      type: Sequelize.ENUM("basse", "normale", "haute", "urgente"),
      allowNull: false,
      defaultValue: "normale",
    });
    await queryInterface.addColumn("project_actions", "dateFin", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("project_actions", "calendarEventId", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "tasks", key: "id" },
      onDelete: "SET NULL",
    });
    await queryInterface.addColumn("project_actions", "googleEventId", {
      type: Sequelize.STRING(200),
      allowNull: true,
    });
    await queryInterface.addColumn("project_actions", "googleCalendarSynced", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn("project_actions", "googleCalendarError", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    // Cache du "updated" renvoyé par Google lors de notre dernière écriture —
    // permet à la sync entrante (Phase B) de distinguer un vrai changement
    // fait dans Google d'un simple écho de notre propre appel API.
    await queryInterface.addColumn("project_actions", "googleUpdatedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    // Dernier seuil de rappel envoyé : null | "24h" | "1h" | "15m"
    await queryInterface.addColumn("project_actions", "lastReminderSent", {
      type: Sequelize.STRING(10),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("project_actions", "lastReminderSent");
    await queryInterface.removeColumn("project_actions", "googleUpdatedAt");
    await queryInterface.removeColumn("project_actions", "googleCalendarError");
    await queryInterface.removeColumn("project_actions", "googleCalendarSynced");
    await queryInterface.removeColumn("project_actions", "googleEventId");
    await queryInterface.removeColumn("project_actions", "calendarEventId");
    await queryInterface.removeColumn("project_actions", "dateFin");
    await queryInterface.removeColumn("project_actions", "priorite");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_project_actions_priorite"`);
  },
};
