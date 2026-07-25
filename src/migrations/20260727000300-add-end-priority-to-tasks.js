"use strict";

// `Task.startAt` n'a jamais eu de borne de fin (le calendrier Flutter
// affichait toujours startAt + 30min en dur) — `endAt` la rend réelle.
// `priority` permet de colorer les rendez-vous issus des actions Timeline.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("tasks", "endAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("tasks", "priority", {
      type: Sequelize.ENUM("basse", "normale", "haute", "urgente"),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("tasks", "priority");
    await queryInterface.removeColumn("tasks", "endAt");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_tasks_priority"`);
  },
};
