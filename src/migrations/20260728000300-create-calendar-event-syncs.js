"use strict";

// Synchronisation Google Calendar multi-destinataires : un événement Google
// donné (pour une ProjectAction ou une CommercialContactRelance) peut exister
// dans PLUSIEURS calendriers Google (toujours info@probardistribution.com +
// le commercial concerné, dédupliqué si identique) — un seul champ
// `googleEventId` par ligne ne suffit plus, il faut une ligne par
// destinataire. Voir multiRecipientCalendarSync.service.js.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("calendar_event_syncs", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      entityType: {
        type: Sequelize.ENUM("project_action", "commercial_contact_relance"),
        allowNull: false,
      },
      entityId: { type: Sequelize.UUID, allowNull: false },
      userId: { type: Sequelize.UUID, allowNull: false },
      googleEventId: { type: Sequelize.STRING(200), allowNull: true },
      googleEventLink: { type: Sequelize.STRING(500), allowNull: true },
      calendarId: { type: Sequelize.STRING(200), allowNull: true, defaultValue: "primary" },
      synced: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      error: { type: Sequelize.TEXT, allowNull: true },
      googleUpdatedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex("calendar_event_syncs", ["entityType", "entityId"]);
    await queryInterface.addConstraint("calendar_event_syncs", {
      fields: ["entityType", "entityId", "userId"],
      type: "unique",
      name: "calendar_event_syncs_entity_user_unique",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("calendar_event_syncs");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_calendar_event_syncs_entityType"`);
  },
};
