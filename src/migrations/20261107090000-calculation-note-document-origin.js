"use strict";

// Notes de calcul : origine de chaque document. Purement additif.
//   calculation_note_documents.origin :
//     INITIAL        — transmis à la création de la note ;
//     ADDED          — ajouté ensuite par un éditeur de la note ;
//     COMPLEMENTARY  — document complémentaire déposé par l'utilisateur affecté.
//   Documents existants : INITIAL s'ils ont été enregistrés avec la note
//   (même transaction, quelques secondes au plus), ADDED sinon. Aucun
//   document n'est modifié ni supprimé.
//   calculation_notes.complementaryVersion : n° du dépôt complémentaire
//   (une notification par dépôt, sans doublon).
module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn("calculation_note_documents", "origin", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "INITIAL" }, { transaction: t });
      await queryInterface.sequelize.query(
        `ALTER TABLE calculation_note_documents ADD CONSTRAINT calculation_note_documents_origin_chk CHECK (origin IN ('INITIAL', 'ADDED', 'COMPLEMENTARY'))`,
        { transaction: t }
      );
      await queryInterface.sequelize.query(
        `UPDATE calculation_note_documents d SET origin = 'ADDED'
           FROM calculation_notes n
          WHERE n.id = d."noteId" AND d."createdAt" > n."createdAt" + INTERVAL '5 seconds'`,
        { transaction: t }
      );
      await queryInterface.addIndex("calculation_note_documents", ["noteId", "origin"], { name: "calculation_note_documents_note_origin_idx", transaction: t });
      await queryInterface.addColumn("calculation_notes", "complementaryVersion", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 }, { transaction: t });
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    // Refusé (sans rien supprimer) si des documents complémentaires existent.
    const [[{ n }]] = await queryInterface.sequelize.query(`SELECT count(*)::int AS n FROM calculation_note_documents WHERE origin = 'COMPLEMENTARY'`);
    if (n > 0) throw new Error(`${n} document(s) complémentaire(s) : annulation refusée pour préserver la traçabilité.`);
    await queryInterface.removeColumn("calculation_notes", "complementaryVersion");
    await queryInterface.removeIndex("calculation_note_documents", "calculation_note_documents_note_origin_idx");
    await queryInterface.sequelize.query(`ALTER TABLE calculation_note_documents DROP CONSTRAINT IF EXISTS calculation_note_documents_origin_chk`);
    await queryInterface.removeColumn("calculation_note_documents", "origin");
  },
};
