"use strict";

// Validation des nouvelles fiches de production par le responsable
// logistique : colonnes nullables ajoutées aux tables existantes des fiches
// (por_promesh pour PROMESH, industrial_records pour PROBAR) + historique des
// décisions. Les fiches existantes gardent approvalStatus NULL : elles ne
// sont ni passées en attente ni modifiées.
const TABLES = ["por_promesh", "industrial_records"];
const COLUMNS = [
  // PENDING | APPROVED | REJECTED — NULL : fiche hors circuit de validation.
  ["approvalStatus", (S) => ({ type: S.STRING(20), allowNull: true })],
  // Numéro de soumission (1 à la création, +1 à chaque nouvelle soumission
  // après un refus) : une décision porte toujours sur une soumission précise.
  ["approvalVersion", (S) => ({ type: S.INTEGER, allowNull: true })],
  ["approvalSubmittedAt", (S) => ({ type: S.DATE, allowNull: true })],
  ["approvalDecidedAt", (S) => ({ type: S.DATE, allowNull: true })],
  ["approvalDecidedBy", (S) => ({ type: S.UUID, allowNull: true })],
  ["approvalDecidedByEmail", (S) => ({ type: S.STRING(255), allowNull: true })],
  // Dernier refus : conservé après une nouvelle soumission (jamais effacé).
  ["approvalRejectedAt", (S) => ({ type: S.DATE, allowNull: true })],
  ["approvalRejectionComment", (S) => ({ type: S.TEXT, allowNull: true })],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const table of TABLES) {
        for (const [col, def] of COLUMNS) await queryInterface.addColumn(table, col, def(Sequelize), { transaction });
        await queryInterface.addIndex(table, ["approvalStatus"], { name: `${table}_approval_status`, transaction });
      }
      await queryInterface.createTable(
        "production_fiche_approval_histories",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          ficheType: { type: Sequelize.STRING(20), allowNull: false },
          ficheId: { type: Sequelize.UUID, allowNull: false },
          version: { type: Sequelize.INTEGER, allowNull: false },
          fromStatus: { type: Sequelize.STRING(20), allowNull: true },
          toStatus: { type: Sequelize.STRING(20), allowNull: false },
          changedBy: { type: Sequelize.UUID, allowNull: true },
          changedByEmail: { type: Sequelize.STRING(255), allowNull: true },
          comment: { type: Sequelize.TEXT, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.addIndex("production_fiche_approval_histories", ["ficheType", "ficheId", "createdAt"], {
        name: "production_fiche_approval_histories_fiche",
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Échoue (sans rien supprimer) si des fiches sont déjà dans le circuit.
      let n = 0;
      for (const table of TABLES) {
        const [[row]] = await queryInterface.sequelize.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE "approvalStatus" IS NOT NULL`,
          { transaction }
        );
        n += row.n;
      }
      if (n > 0) throw new Error(`${n} fiche(s) dans le circuit de validation : annulation refusée pour préserver la traçabilité.`);
      await queryInterface.dropTable("production_fiche_approval_histories", { transaction });
      for (const table of TABLES) {
        await queryInterface.removeIndex(table, `${table}_approval_status`, { transaction });
        for (const [col] of [...COLUMNS].reverse()) await queryInterface.removeColumn(table, col, { transaction });
      }
    });
  },
};
