"use strict";

// userId sur email_queue : jusqu'ici seul `meta` (JSON) portait
// éventuellement un userId, ce qui rend impossible une requête fiable/
// indexée "y a-t-il déjà un job actif pour cet utilisateur ?" (nécessaire
// pour dédupliquer les envois MFA — voir services/mfa.service.js). Colonne
// nullable : les jobs existants (forgot-password notamment) restent
// valides sans backfill, seul le nouveau code MFA la renseigne.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("email_queue", "userId", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    });

    await queryInterface.addIndex("email_queue", ["userId", "context", "status"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("email_queue", ["userId", "context", "status"]);
    await queryInterface.removeColumn("email_queue", "userId");
  },
};
