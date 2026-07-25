"use strict";

// Module "Contrôle Machine" PROMESH — nettoyage demandé :
//   1. Suppression complète de 3 champs hors périmètre du contrôle machine :
//      bainResine, etatAtelier, zoneStockage. Toute valeur déjà saisie sur
//      des fiches existantes est perdue (colonnes droppées) — c'est le
//      comportement explicitement demandé ("supprimer complètement"), le
//      front ne les affiche/n'envoie plus non plus.
//   2. Renommage `temperatureDemandee` → `temperaturePistons` (DOUBLE au
//      lieu de DECIMAL(10,2) — saisie libre, plus de boutons préréglés
//      160/170/180). Les valeurs existantes sont copiées avant suppression
//      de l'ancienne colonne, aucune donnée de température perdue.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("por_promesh", "temperaturePistons", {
      type: Sequelize.DOUBLE,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE por_promesh
      SET "temperaturePistons" = "temperatureDemandee"::double precision
      WHERE "temperatureDemandee" IS NOT NULL;
    `);

    await queryInterface.removeColumn("por_promesh", "temperatureDemandee");
    await queryInterface.removeColumn("por_promesh", "bainResine");
    await queryInterface.removeColumn("por_promesh", "etatAtelier");
    await queryInterface.removeColumn("por_promesh", "zoneStockage");
  },

  async down(queryInterface, Sequelize) {
    // bainResine / etatAtelier / zoneStockage : colonnes recréées vides —
    // leurs anciennes valeurs ne sont pas récupérables (droppées par up()).
    await queryInterface.addColumn("por_promesh", "bainResine", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "etatAtelier", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.addColumn("por_promesh", "zoneStockage", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });

    await queryInterface.addColumn("por_promesh", "temperatureDemandee", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
    await queryInterface.sequelize.query(`
      UPDATE por_promesh
      SET "temperatureDemandee" = "temperaturePistons"::numeric(10,2)
      WHERE "temperaturePistons" IS NOT NULL;
    `);
    await queryInterface.removeColumn("por_promesh", "temperaturePistons");
  },
};
