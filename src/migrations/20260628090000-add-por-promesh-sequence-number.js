"use strict";

// Numéro de fiche lisible (ex. "PROMESH-2026-000001", calculé côté DTO à
// partir de sequenceNumber + l'année de createdAt) — jamais l'UUID exposé à
// l'utilisateur. L'UUID reste la clé primaire ; sequenceNumber n'est qu'un
// numéro métier d'affichage.
//
// Pourquoi pas un simple "ADD COLUMN ... SERIAL" : Postgres backfillerait
// alors les lignes existantes dans un ordre non garanti. Ici on ajoute la
// colonne en NULL, on numérote explicitement les fiches déjà en base par
// ordre de création (compatibilité demandée), puis on attache une séquence
// Postgres pour que chaque future fiche reçoive automatiquement le numéro
// suivant (auto-increment "logique", sans calcul MAX()+1 côté application —
// ça éviterait une race condition entre deux créations concurrentes).
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('ALTER TABLE "por_promesh" ADD COLUMN "sequenceNumber" INTEGER');

    // Compatibilité : numérote les fiches déjà en base, triées par date de
    // création (1, 2, 3, ...).
    await sequelize.query(`
      WITH ordered AS (
        SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) AS rn
        FROM "por_promesh"
      )
      UPDATE "por_promesh" p
      SET "sequenceNumber" = ordered.rn
      FROM ordered
      WHERE p."id" = ordered."id"
    `);

    // Séquence Postgres pour les futures fiches — reprend après le dernier
    // numéro déjà attribué (0 si la table est vide).
    await sequelize.query('CREATE SEQUENCE IF NOT EXISTS "por_promesh_sequenceNumber_seq"');
    await sequelize.query(`
      SELECT setval('"por_promesh_sequenceNumber_seq"', COALESCE((SELECT MAX("sequenceNumber") FROM "por_promesh"), 0))
    `);
    await sequelize.query(
      'ALTER TABLE "por_promesh" ALTER COLUMN "sequenceNumber" SET DEFAULT nextval(\'"por_promesh_sequenceNumber_seq"\')'
    );
    // La séquence suit le cycle de vie de la colonne (DROP COLUMN/TABLE la supprime aussi).
    await sequelize.query(
      'ALTER SEQUENCE "por_promesh_sequenceNumber_seq" OWNED BY "por_promesh"."sequenceNumber"'
    );

    // Toutes les lignes ont désormais une valeur (existantes : backfill ;
    // futures : DEFAULT nextval) — on peut imposer NOT NULL + UNIQUE.
    await sequelize.query('ALTER TABLE "por_promesh" ALTER COLUMN "sequenceNumber" SET NOT NULL');
    await sequelize.query(
      'ALTER TABLE "por_promesh" ADD CONSTRAINT "por_promesh_sequenceNumber_unique" UNIQUE ("sequenceNumber")'
    );
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      'ALTER TABLE "por_promesh" DROP CONSTRAINT IF EXISTS "por_promesh_sequenceNumber_unique"'
    );
    // DROP COLUMN supprime aussi la séquence (ALTER SEQUENCE ... OWNED BY).
    await queryInterface.removeColumn("por_promesh", "sequenceNumber");
  },
};
