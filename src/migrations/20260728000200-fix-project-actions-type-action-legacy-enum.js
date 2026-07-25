"use strict";

// BUG RÉEL découvert en vérifiant "les actions ne sont pas créées" : la
// colonne physique `typeAction_legacy` est en réalité un ENUM Postgres
// (`enum_project_actions_typeAction`, reliquat d'un ancien renommage de
// colonne — Postgres ne renomme jamais le TYPE enum sous-jacent) limité à
// 9 valeurs (Visite, Plan technique, Echantillonnage, Devis envoyé,
// Negociation, Relance, Commande gagnée, Commande perdue, Fidelisation) —
// alors que le modèle Sequelize la déclare comme `STRING(100)` (texte
// libre). Toute action d'un type hors de cette liste — "Appel", "Réunion",
// "Maintenance", "Suivi", "Démonstration", "Installation", pourtant tous
// des types demandés — échoue en HTTP 500 ("valeur en entrée invalide pour
// le enum") et n'est donc jamais créée, ni synchronisée, ni notifiée.
//
// Fix : aligner la colonne réelle sur ce que le modèle a toujours prétendu
// être — VARCHAR(100), texte libre — pour permettre "Appel", "Réunion",
// "Maintenance" et tout autre type d'action, présent ou futur.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "project_actions" ALTER COLUMN "typeAction_legacy" TYPE VARCHAR(100) USING "typeAction_legacy"::text`
    );
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_project_actions_typeAction"`);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      `CREATE TYPE "enum_project_actions_typeAction" AS ENUM (
        'Visite', 'Plan technique', 'Echantillonnage', 'Devis envoyé',
        'Negociation', 'Relance', 'Commande gagnée', 'Commande perdue', 'Fidelisation'
      )`
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "project_actions" ALTER COLUMN "typeAction_legacy" TYPE "enum_project_actions_typeAction" USING "typeAction_legacy"::"enum_project_actions_typeAction"`
    );
  },
};
