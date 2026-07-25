"use strict";

// Champs additifs : synchro Google Calendar (googleEventId permet de
// mettre à jour/supprimer le même événement plutôt que d'en recréer un) +
// traçabilité des échecs best-effort email/WhatsApp (jamais bloquants,
// mais l'erreur doit rester consultable sur le Follow-up).
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("commercial_contact_relances");

    if (!table.googleEventId) {
      await queryInterface.addColumn("commercial_contact_relances", "googleEventId", {
        type: Sequelize.STRING(200),
        allowNull: true,
      });
    }
    if (!table.googleCalendarSynced) {
      await queryInterface.addColumn("commercial_contact_relances", "googleCalendarSynced", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
    if (!table.googleCalendarError) {
      await queryInterface.addColumn("commercial_contact_relances", "googleCalendarError", {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
    if (!table.emailError) {
      await queryInterface.addColumn("commercial_contact_relances", "emailError", {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
    if (!table.whatsappError) {
      await queryInterface.addColumn("commercial_contact_relances", "whatsappError", {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("commercial_contact_relances");
    if (table.whatsappError) await queryInterface.removeColumn("commercial_contact_relances", "whatsappError");
    if (table.emailError) await queryInterface.removeColumn("commercial_contact_relances", "emailError");
    if (table.googleCalendarError) await queryInterface.removeColumn("commercial_contact_relances", "googleCalendarError");
    if (table.googleCalendarSynced) await queryInterface.removeColumn("commercial_contact_relances", "googleCalendarSynced");
    if (table.googleEventId) await queryInterface.removeColumn("commercial_contact_relances", "googleEventId");
  },
};
