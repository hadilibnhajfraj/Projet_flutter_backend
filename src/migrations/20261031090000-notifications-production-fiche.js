"use strict";

// Notifications liées à une fiche de production (validation par le
// responsable logistique) : type + id de la fiche pour l'ouvrir depuis la
// notification, numéro de soumission. L'index unique partiel garantit une
// seule notification par destinataire, type, fiche et soumission (aucun
// doublon en cas de nouvelle tentative). Colonnes nullables : les
// notifications existantes ne sont pas modifiées.
const INDEX = "notifications_production_fiche_unique";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn("notifications", "productionFicheType", { type: Sequelize.STRING(20), allowNull: true }, { transaction });
      await queryInterface.addColumn("notifications", "productionFicheId", { type: Sequelize.UUID, allowNull: true }, { transaction });
      await queryInterface.addColumn("notifications", "productionFicheVersion", { type: Sequelize.INTEGER, allowNull: true }, { transaction });
      await queryInterface.addIndex("notifications", ["userId", "type", "productionFicheId", "productionFicheVersion"], {
        name: INDEX,
        unique: true,
        where: { productionFicheId: { [Sequelize.Op.ne]: null } },
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Échoue (sans rien supprimer) si des notifications de fiche existent.
      const [[{ n }]] = await queryInterface.sequelize.query(
        `SELECT count(*)::int AS n FROM notifications WHERE "productionFicheId" IS NOT NULL`,
        { transaction }
      );
      if (n > 0) throw new Error(`${n} notification(s) de fiche de production : annulation refusée pour préserver la traçabilité.`);
      await queryInterface.removeIndex("notifications", INDEX, { transaction });
      for (const col of ["productionFicheVersion", "productionFicheId", "productionFicheType"]) {
        await queryInterface.removeColumn("notifications", col, { transaction });
      }
    });
  },
};
