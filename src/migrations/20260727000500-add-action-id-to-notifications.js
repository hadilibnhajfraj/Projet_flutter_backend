"use strict";

// Relation flexible supplémentaire (même pattern que relanceId/hrRequestId) —
// permet de tracer une notification jusqu'à l'action Timeline (calendrier/
// Google Calendar/rappel) qui l'a déclenchée.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("notifications", "actionId", {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await queryInterface.addIndex("notifications", ["actionId"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("notifications", ["actionId"]);
    await queryInterface.removeColumn("notifications", "actionId");
  },
};
