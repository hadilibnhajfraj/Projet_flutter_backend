"use strict";

// Traçabilité de l'UTILISATION d'une autorisation de rattrapage (backfill) :
// en plus de usedAt / usedFicheType / usedFicheId (déjà existants), on
// conserve QUI a réellement créé/re-daté la fiche avec cette autorisation —
// "Approved by" (authorizedByEmail) et "Used by" (usedByEmail) restent ainsi
// tous deux consultables. Colonnes nullables : les autorisations déjà
// consommées avant cette migration gardent NULL (aucune donnée inventée).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn("production_compliance_authorizations", "usedBy", { type: Sequelize.UUID, allowNull: true }, { transaction });
      await queryInterface.addColumn("production_compliance_authorizations", "usedByEmail", { type: Sequelize.STRING(255), allowNull: true }, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn("production_compliance_authorizations", "usedByEmail", { transaction });
      await queryInterface.removeColumn("production_compliance_authorizations", "usedBy", { transaction });
    });
  },
};
