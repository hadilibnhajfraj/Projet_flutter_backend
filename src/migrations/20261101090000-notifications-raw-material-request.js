"use strict";

// Notifications liées à une demande de matières premières : identifiant de
// la demande, pour l'ouvrir directement depuis la notification. Colonne
// nullable : les notifications existantes ne sont pas modifiées.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("notifications", "rawMaterialRequestId", { type: Sequelize.UUID, allowNull: true });
  },

  async down(queryInterface) {
    // Échoue (sans rien supprimer) si des notifications y sont déjà liées.
    const [[{ n }]] = await queryInterface.sequelize.query(
      `SELECT count(*)::int AS n FROM notifications WHERE "rawMaterialRequestId" IS NOT NULL`
    );
    if (n > 0) throw new Error(`${n} notification(s) de demande de matières premières : annulation refusée pour préserver la traçabilité.`);
    await queryInterface.removeColumn("notifications", "rawMaterialRequestId");
  },
};
