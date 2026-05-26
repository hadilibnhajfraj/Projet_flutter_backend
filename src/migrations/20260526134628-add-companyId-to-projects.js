'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('projects', 'companyId', {
      type: Sequelize.UUID,
      allowNull: true
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('projects', 'companyId');
  }
};