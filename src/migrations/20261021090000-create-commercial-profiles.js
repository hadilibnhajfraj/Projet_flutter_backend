"use strict";

// Profils commerciaux personnalisés ("Autre commercial" de la dialog
// "Sélection du commercial") : jusqu'ici le nom saisi n'était écrit que dans
// le stockage local du navigateur et GET /commercial-contacts/user-names/list
// ne le retrouvait que s'il figurait déjà sur un contact — il disparaissait
// donc à la reconnexion. Une ligne = un nom, rattaché au compte qui l'a créé
// (unicité par compte, insensible à la casse via `nameKey`).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("commercial_profiles", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      nameKey: { type: Sequelize.STRING(120), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addConstraint("commercial_profiles", {
      fields: ["userId", "nameKey"],
      type: "unique",
      name: "commercial_profiles_user_name_unique",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("commercial_profiles");
  },
};
