"use strict";

// Index composite couvrant exactement la requête utilisée par
// industrialRecord.repository.js#findAll : WHERE module = ? ORDER BY
// dateFiche DESC, createdAt DESC. Sans cet index, Postgres filtre via
// l'index simple sur `module` puis trie séparément (nœud Sort) l'ensemble
// des lignes filtrées — coût qui croît avec le nombre de fiches MÉLANGE.
// Idempotent : vérifie l'absence de l'index avant de le créer.
const INDEX_NAME = "industrial_records_module_datefiche_createdat";

module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'industrial_records' AND indexname = :name`,
      { replacements: { name: INDEX_NAME } }
    );
    if (existing.length > 0) return;

    await queryInterface.addIndex("industrial_records", ["module", "dateFiche", "createdAt"], {
      name: INDEX_NAME,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("industrial_records", INDEX_NAME);
  },
};
