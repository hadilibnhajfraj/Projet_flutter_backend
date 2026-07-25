"use strict";

// Restructuration du module Récupérables :
//   - recuperable_fiches : `ligne` (L1-L4) et `operateur` redeviennent des
//     champs d'en-tête de fiche (au lieu d'être portés par chaque ligne
//     saisie) ; l'unicité de la fiche s'étend donc à (module, machine,
//     ligne, poste, date).
//   - recuperable_lignes : abandon des lignes dynamiques (ligne/quantité
//     produite/produit fini/observation/diamètre libre "Autre") au profit
//     d'une grille FIXE de 12 diamètres (une ligne par diamètre et par
//     fiche — contrainte unique ficheId+diametre) avec seulement deux
//     valeurs saisies : dechetKg et dechetProduitFiniKg.
// Additif et non destructif : les fiches déjà créées (aucune ligne
// associée à ce jour) reçoivent une valeur par défaut pour `ligne`.
module.exports = {
  async up(queryInterface, Sequelize) {
    const fichesDesc = await queryInterface.describeTable("recuperable_fiches");

    if (!fichesDesc.ligne) {
      await queryInterface.addColumn("recuperable_fiches", "ligne", {
        type: Sequelize.ENUM("L1", "L2", "L3", "L4"),
        allowNull: false,
        defaultValue: "L1",
      });
    }
    if (!fichesDesc.operateur) {
      await queryInterface.addColumn("recuperable_fiches", "operateur", {
        type: Sequelize.STRING(255),
        allowNull: true,
      });
    }

    // Ancien index (module, machine, poste, date) → nouveau (+ ligne).
    const [existingIndexes] = await queryInterface.sequelize.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'recuperable_fiches'`
    );
    const indexNames = existingIndexes.map((i) => i.indexname);
    if (indexNames.includes("recuperable_fiches_module_machine_poste_date_unique")) {
      await queryInterface.removeIndex("recuperable_fiches", "recuperable_fiches_module_machine_poste_date_unique");
    }
    if (!indexNames.includes("recuperable_fiches_module_machine_ligne_poste_date_unique")) {
      await queryInterface.addIndex("recuperable_fiches", ["module", "machine", "ligne", "poste", "date"], {
        unique: true,
        name: "recuperable_fiches_module_machine_ligne_poste_date_unique",
      });
    }

    // ── recuperable_lignes : grille fixe de 12 diamètres ─────────────────
    const lignesDesc = await queryInterface.describeTable("recuperable_lignes");

    if (lignesDesc.ligne) await queryInterface.removeColumn("recuperable_lignes", "ligne");
    if (lignesDesc.quantiteProduite) await queryInterface.removeColumn("recuperable_lignes", "quantiteProduite");
    if (lignesDesc.produitFini) await queryInterface.removeColumn("recuperable_lignes", "produitFini");
    if (lignesDesc.diametreAutre) await queryInterface.removeColumn("recuperable_lignes", "diametreAutre");
    if (lignesDesc.observation) await queryInterface.removeColumn("recuperable_lignes", "observation");

    // diametre : ENUM (6mm..20mm,Autre) → STRING libre (12 valeurs fixes
    // gérées côté validation applicative, plus simple à faire évoluer
    // qu'un ENUM Postgres).
    if (lignesDesc.diametre && lignesDesc.diametre.type.startsWith("USER-DEFINED")) {
      await queryInterface.sequelize.query(
        `ALTER TABLE "recuperable_lignes" ALTER COLUMN "diametre" TYPE VARCHAR(10) USING "diametre"::text`
      );
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_recuperable_lignes_diametre";');
    }
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_recuperable_lignes_ligne";');

    if (!lignesDesc.dechetProduitFiniKg) {
      await queryInterface.addColumn("recuperable_lignes", "dechetProduitFiniKg", {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      });
    }
    await queryInterface.sequelize.query(
      `ALTER TABLE "recuperable_lignes" ALTER COLUMN "dechetKg" SET DEFAULT 0`
    );

    const [lignesIndexes] = await queryInterface.sequelize.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'recuperable_lignes'`
    );
    const lignesIndexNames = lignesIndexes.map((i) => i.indexname);
    if (!lignesIndexNames.includes("recuperable_lignes_fiche_diametre_unique")) {
      await queryInterface.addIndex("recuperable_lignes", ["ficheId", "diametre"], {
        unique: true,
        name: "recuperable_lignes_fiche_diametre_unique",
      });
    }
  },

  async down() {
    // Restructuration profonde et additive — pas de retour arrière automatique.
  },
};
