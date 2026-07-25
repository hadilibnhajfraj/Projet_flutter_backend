"use strict";

// Historique complet des changements de statut d'un CommercialContact.
// Suit les DEUX champs "statut" (résultat d'appel) et "pipelineStage"
// (étape de l'entonnoir commercial) — une ligne par changement d'UN seul
// champ (colonne "field" additive, nécessaire pour distinguer les deux
// vocabulaires dans une timeline unifiée). Jamais écrasé, jamais mis à
// jour après coup : chaque changement crée une nouvelle ligne (append-only).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("commercial_contact_status_histories", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },

      commercialContactId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "commercial_contacts", key: "id" },
        onDelete: "CASCADE",
      },

      // "statut" | "pipelineStage" — quel champ a changé.
      field: { type: Sequelize.STRING(20), allowNull: false },

      ancienStatut: { type: Sequelize.STRING(50), allowNull: true },
      nouveauStatut: { type: Sequelize.STRING(50), allowNull: false },

      commentaire: { type: Sequelize.TEXT, allowNull: true },

      changedBy: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
      },
      // Snapshot du nom affiché au moment du changement — ne doit jamais
      // changer rétroactivement si le profil de l'utilisateur est modifié
      // plus tard.
      changedByName: { type: Sequelize.STRING(200), allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("commercial_contact_status_histories", ["commercialContactId"]);
    await queryInterface.addIndex("commercial_contact_status_histories", ["createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("commercial_contact_status_histories");
  },
};
