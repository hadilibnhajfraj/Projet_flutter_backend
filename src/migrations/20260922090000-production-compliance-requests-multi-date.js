"use strict";

// Une demande de régularisation couvre désormais TOUTES les dates manquantes
// détectées au moment de la demande (pas une seule) : ajout de
// missingDates (tableau JSONB) et createdAuthorizationIds (une autorisation
// par date, créées ensemble à l'approbation). `missingDate` / `createdAuthorizationId`
// (singulier) sont conservés à titre de compatibilité (première date / première
// autorisation) mais ne sont plus la source de vérité.
//
// La contrainte d'unicité passe de (userId, productionType, missingDate) à
// (userId, productionType) — une seule demande PENDING à la fois par
// utilisateur + production, quel que soit le nombre de dates couvertes.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        "production_compliance_authorization_requests",
        "missingDates",
        { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        { transaction }
      );
      await queryInterface.addColumn(
        "production_compliance_authorization_requests",
        "createdAuthorizationIds",
        { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        { transaction }
      );
      // Backfill des lignes existantes (le cas échéant) : missingDates = [missingDate].
      await queryInterface.sequelize.query(
        `UPDATE production_compliance_authorization_requests
            SET "missingDates" = jsonb_build_array("missingDate"::text),
                "createdAuthorizationIds" = CASE WHEN "createdAuthorizationId" IS NOT NULL THEN jsonb_build_array("createdAuthorizationId"::text) ELSE '[]'::jsonb END
          WHERE "missingDates" = '[]'::jsonb`,
        { transaction }
      );
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS uq_pc_request_pending`, { transaction });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_pc_request_pending
           ON production_compliance_authorization_requests ("userId", "productionType")
           WHERE status = 'PENDING'`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS uq_pc_request_pending`);
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX uq_pc_request_pending
         ON production_compliance_authorization_requests ("userId", "productionType", "missingDate")
         WHERE status = 'PENDING'`
    );
    await queryInterface.removeColumn("production_compliance_authorization_requests", "createdAuthorizationIds");
    await queryInterface.removeColumn("production_compliance_authorization_requests", "missingDates");
  },
};
