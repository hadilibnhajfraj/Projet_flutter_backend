'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('projects', 'engineerId', {
      type: Sequelize.UUID,
      allowNull: true
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('projects', 'engineerId');
  }
};