"use strict";

// Distingue la toute première entrée d'un contact (création, type=CREATED)
// des changements ultérieurs (type=STATUS_CHANGED) — permet un rendu
// dédié côté Flutter ("Création du contact" vs "Ancien statut / Nouveau
// statut"). Backfill des lignes déjà existantes : une ligne sans
// ancienStatut ne peut être qu'une entrée de création.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("commercial_contact_status_histories");

    if (!table.type) {
      await queryInterface.addColumn("commercial_contact_status_histories", "type", {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: "STATUS_CHANGED",
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE commercial_contact_status_histories
      SET "type" = 'CREATED'
      WHERE "ancienStatut" IS NULL;
    `);
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("commercial_contact_status_histories");
    if (table.type) {
      await queryInterface.removeColumn("commercial_contact_status_histories", "type");
    }
  },
};
