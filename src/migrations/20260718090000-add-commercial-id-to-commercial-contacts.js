"use strict";

// Ajoute un rattachement DIRECT et PERSISTANT contact <-> commercial sur
// commercial_contacts.commercialId — distinct de
// commercial_contact_relances.commercialId (qui ne concerne qu'une relance
// ponctuelle et peut changer d'un Follow-up à l'autre). C'est ce champ que
// l'action d'administration "Affecter des contacts" renseigne, et que le
// scope de filtrage GET /commercial-contacts utilise en OR avec createdBy.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("commercial_contacts");

    if (!table.commercialId) {
      await queryInterface.addColumn("commercial_contacts", "commercialId", {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      });
    }

    await queryInterface.addIndex("commercial_contacts", ["commercialId"], {
      name: "commercial_contacts_commercial_id_idx",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("commercial_contacts", "commercial_contacts_commercial_id_idx");
    const table = await queryInterface.describeTable("commercial_contacts");
    if (table.commercialId) {
      await queryInterface.removeColumn("commercial_contacts", "commercialId");
    }
  },
};
