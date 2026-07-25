"use strict";

// Champs support de l'automatisation Follow-up (calendrier / notifications /
// email / WhatsApp / rappels) — additifs uniquement, aucune donnée existante
// touchée. commercialId/commercialName/commercialEmail identifient le
// commercial choisi lors de la création/modification d'un Follow-up.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("commercial_contact_relances");

    if (!table.commercialId) {
      await queryInterface.addColumn("commercial_contact_relances", "commercialId", {
        type: Sequelize.UUID,
        allowNull: true,
      });
    }
    if (!table.commercialName) {
      await queryInterface.addColumn("commercial_contact_relances", "commercialName", {
        type: Sequelize.STRING(200),
        allowNull: true,
      });
    }
    if (!table.commercialEmail) {
      await queryInterface.addColumn("commercial_contact_relances", "commercialEmail", {
        type: Sequelize.STRING(200),
        allowNull: true,
      });
    }
    if (!table.calendarEventId) {
      await queryInterface.addColumn("commercial_contact_relances", "calendarEventId", {
        type: Sequelize.UUID,
        allowNull: true,
      });
    }
    if (!table.notificationSent) {
      await queryInterface.addColumn("commercial_contact_relances", "notificationSent", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
    if (!table.whatsappSent) {
      await queryInterface.addColumn("commercial_contact_relances", "whatsappSent", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
    if (!table.lastReminderSent) {
      await queryInterface.addColumn("commercial_contact_relances", "lastReminderSent", {
        type: Sequelize.STRING(10),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("commercial_contact_relances");
    if (table.lastReminderSent) await queryInterface.removeColumn("commercial_contact_relances", "lastReminderSent");
    if (table.whatsappSent) await queryInterface.removeColumn("commercial_contact_relances", "whatsappSent");
    if (table.notificationSent) await queryInterface.removeColumn("commercial_contact_relances", "notificationSent");
    if (table.calendarEventId) await queryInterface.removeColumn("commercial_contact_relances", "calendarEventId");
    if (table.commercialEmail) await queryInterface.removeColumn("commercial_contact_relances", "commercialEmail");
    if (table.commercialName) await queryInterface.removeColumn("commercial_contact_relances", "commercialName");
    if (table.commercialId) await queryInterface.removeColumn("commercial_contact_relances", "commercialId");
  },
};
