"use strict";

// Module « Notes de calcul » (documents techniques liés aux projets CRM).
// Purement additif : 4 nouvelles tables, aucune table existante modifiée.
//
//   calculation_note_counters  — compteur ANNUEL des références NC-AAAA-NNNN.
//     Incrémenté par un upsert atomique (verrou de ligne) dans la transaction
//     de création : deux créations simultanées ne peuvent jamais obtenir le
//     même numéro, et le compteur ne redescend jamais (un numéro attribué
//     n'est jamais réutilisé, même après suppression). Jamais COUNT(*) + 1.
//   calculation_notes          — la note (id = séquence PostgreSQL SERIAL).
//   calculation_note_documents — fichiers (stockage privé hors /uploads).
//   calculation_note_histories — historique des ajouts et modifications.
//
// Aucune suppression en cascade : les notes et documents ne sont jamais
// supprimés par effet de bord (RESTRICT sur projets et utilisateurs).

module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        "calculation_note_counters",
        {
          year: { type: Sequelize.INTEGER, primaryKey: true },
          lastValue: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction: t }
      );

      await queryInterface.createTable(
        "calculation_notes",
        {
          id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
          reference: { type: Sequelize.STRING(30), allowNull: false },
          year: { type: Sequelize.INTEGER, allowNull: false },
          sequenceNumber: { type: Sequelize.INTEGER, allowNull: false },
          projectId: { type: Sequelize.UUID, allowNull: false, references: { model: "projects", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          requesterId: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          createdBy: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          commentaire: { type: Sequelize.TEXT, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction: t }
      );
      await queryInterface.addIndex("calculation_notes", ["reference"], { unique: true, name: "calculation_notes_reference_uq", transaction: t });
      await queryInterface.addIndex("calculation_notes", ["year", "sequenceNumber"], { unique: true, name: "calculation_notes_year_seq_uq", transaction: t });
      await queryInterface.addIndex("calculation_notes", ["projectId"], { name: "calculation_notes_project_idx", transaction: t });
      await queryInterface.addIndex("calculation_notes", ["requesterId"], { name: "calculation_notes_requester_idx", transaction: t });
      await queryInterface.addIndex("calculation_notes", ["createdAt"], { name: "calculation_notes_created_at_idx", transaction: t });

      await queryInterface.createTable(
        "calculation_note_documents",
        {
          id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal("gen_random_uuid()") },
          noteId: { type: Sequelize.INTEGER, allowNull: false, references: { model: "calculation_notes", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          projectId: { type: Sequelize.UUID, allowNull: false, references: { model: "projects", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          originalName: { type: Sequelize.STRING(255), allowNull: false },
          storedFileName: { type: Sequelize.STRING(120), allowNull: false },
          extension: { type: Sequelize.STRING(10), allowNull: false },
          mimeType: { type: Sequelize.STRING(120), allowNull: false },
          sizeBytes: { type: Sequelize.BIGINT, allowNull: false },
          sha256: { type: Sequelize.STRING(64), allowNull: false },
          commentaire: { type: Sequelize.TEXT, allowNull: true },
          uploadedBy: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction: t }
      );
      await queryInterface.addIndex("calculation_note_documents", ["storedFileName"], { unique: true, name: "calculation_note_documents_stored_uq", transaction: t });
      await queryInterface.addIndex("calculation_note_documents", ["noteId"], { name: "calculation_note_documents_note_idx", transaction: t });
      await queryInterface.addIndex("calculation_note_documents", ["projectId"], { name: "calculation_note_documents_project_idx", transaction: t });

      await queryInterface.createTable(
        "calculation_note_histories",
        {
          id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal("gen_random_uuid()") },
          noteId: { type: Sequelize.INTEGER, allowNull: false, references: { model: "calculation_notes", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          documentId: { type: Sequelize.UUID, allowNull: true, references: { model: "calculation_note_documents", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          // NOTE_CREATED | NOTE_UPDATED | DOCUMENT_ADDED | DOCUMENT_COMMENT_UPDATED
          action: { type: Sequelize.STRING(40), allowNull: false },
          userId: { type: Sequelize.UUID, allowNull: false, references: { model: "users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT" },
          details: { type: Sequelize.JSONB, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction: t }
      );
      await queryInterface.addIndex("calculation_note_histories", ["noteId", "createdAt"], { name: "calculation_note_histories_note_idx", transaction: t });

      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    // Retire uniquement les tables de ce module (aucune autre donnée).
    await queryInterface.dropTable("calculation_note_histories");
    await queryInterface.dropTable("calculation_note_documents");
    await queryInterface.dropTable("calculation_notes");
    await queryInterface.dropTable("calculation_note_counters");
  },
};
