"use strict";

// Bug réel corrigé : le calendrier CRM (table `tasks`) d'un follow-up n'était
// créé que pour le créateur (`createdBy: actorUserId`, toujours
// info@probardistribution.com) — le commercial affecté au projet ne voyait
// jamais la relance dans son propre Calendrier Follow-up. Chaque
// destinataire a maintenant SA PROPRE ligne `tasks` (Task.createdBy =
// destinataire — c'est ce champ qui pilote déjà le filtre de
// `GET /tasks`), trackée ici au même titre que son événement Google.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("calendar_event_syncs", "taskId", {
      type: Sequelize.UUID,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("calendar_event_syncs", "taskId");
  },
};
