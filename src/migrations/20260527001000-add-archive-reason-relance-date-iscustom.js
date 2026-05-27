"use strict";

// Adds:
//   projects.archiveReason    — TEXT   — reason stored when a project is archived
//   projects.nextRelanceDate  — DATE   — planned next follow-up date (drives relanceStatus)
//   pipeline_stages.isCustom — BOOLEAN — distinguishes user-created stages from seeded defaults

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("projects", "archiveReason", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("projects", "nextRelanceDate", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("pipeline_stages", "isCustom", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("projects", "archiveReason");
    await queryInterface.removeColumn("projects", "nextRelanceDate");
    await queryInterface.removeColumn("pipeline_stages", "isCustom");
  },
};
