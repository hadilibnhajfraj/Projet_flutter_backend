"use strict";

// Prise en charge par le shift soir d'une demande de matières premières
// validée par le responsable logistique :
//   - quantités réelles par matière (actualItems), séparées des lignes
//     validées (items) qui ne sont jamais modifiées ;
//   - auteur, date et heure de l'acceptation ou du refus, motif du refus.
// La validation logistique (validatedAt / validatedBy) n'est pas touchée.
// Colonnes nullables : les demandes existantes restent inchangées.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const add = (col, def) => queryInterface.addColumn("raw_material_requests", col, def, { transaction });
      // [{ material, quantiteReelle }] — mêmes codes matière que `items`.
      await add("actualItems", { type: Sequelize.JSONB, allowNull: true });
      await add("eveningHandledAt", { type: Sequelize.DATE, allowNull: true });
      await add("eveningHandledBy", { type: Sequelize.UUID, allowNull: true });
      await add("eveningHandledByEmail", { type: Sequelize.STRING(255), allowNull: true });
      await add("eveningRefusalComment", { type: Sequelize.TEXT, allowNull: true });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Échoue (sans rien supprimer) si des demandes ont déjà été traitées par le shift soir.
      const [[{ n }]] = await queryInterface.sequelize.query(
        `SELECT count(*)::int AS n FROM raw_material_requests WHERE status IN ('EVENING_ACCEPTED', 'EVENING_REFUSED')`,
        { transaction }
      );
      if (n > 0) throw new Error(`${n} demande(s) traitée(s) par le shift soir : annulation refusée pour préserver la traçabilité.`);
      for (const col of ["eveningRefusalComment", "eveningHandledByEmail", "eveningHandledBy", "eveningHandledAt", "actualItems"]) {
        await queryInterface.removeColumn("raw_material_requests", col, { transaction });
      }
    });
  },
};
