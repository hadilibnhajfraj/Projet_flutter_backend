"use strict";

// Champs RH nécessaires à l'auto-remplissage du module "Demandes" (congé /
// autorisation de sortie) — l'utilisateur ne doit jamais les saisir lui-même,
// ils doivent être renseignés une fois par un administrateur.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("user_profiles");

    if (!table.nom) {
      await queryInterface.addColumn("user_profiles", "nom", {
        type: Sequelize.STRING(120),
        allowNull: true,
      });
    }
    if (!table.prenom) {
      await queryInterface.addColumn("user_profiles", "prenom", {
        type: Sequelize.STRING(120),
        allowNull: true,
      });
    }
    if (!table.matricule) {
      await queryInterface.addColumn("user_profiles", "matricule", {
        type: Sequelize.STRING(50),
        allowNull: true,
      });
    }
    if (!table.qualification) {
      await queryInterface.addColumn("user_profiles", "qualification", {
        type: Sequelize.STRING(150),
        allowNull: true,
      });
    }
    if (!table.departement) {
      await queryInterface.addColumn("user_profiles", "departement", {
        type: Sequelize.STRING(150),
        allowNull: true,
      });
    }
    if (!table.service) {
      await queryInterface.addColumn("user_profiles", "service", {
        type: Sequelize.STRING(150),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("user_profiles");
    if (table.service) await queryInterface.removeColumn("user_profiles", "service");
    if (table.departement) await queryInterface.removeColumn("user_profiles", "departement");
    if (table.qualification) await queryInterface.removeColumn("user_profiles", "qualification");
    if (table.matricule) await queryInterface.removeColumn("user_profiles", "matricule");
    if (table.prenom) await queryInterface.removeColumn("user_profiles", "prenom");
    if (table.nom) await queryInterface.removeColumn("user_profiles", "nom");
  },
};
