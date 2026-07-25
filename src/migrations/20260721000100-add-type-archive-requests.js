"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("archive_requests", "type", {
      type: Sequelize.ENUM("ARCHIVAGE", "DESARCHIVAGE"),
      allowNull: false,
      defaultValue: "DESARCHIVAGE",
    });

    await queryInterface.addColumn("archive_requests", "rejectionReason", {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addIndex("archive_requests", ["type"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("archive_requests", ["type"]);
    await queryInterface.removeColumn("archive_requests", "rejectionReason");
    await queryInterface.removeColumn("archive_requests", "type");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_archive_requests_type"`);
  },
};
