"use strict";

// Journal d'audit des fiches de production PROBAR / PROMESH. Purement
// additif : aucune table existante ni aucune fiche n'est modifiée.
//   production_fiche_audit — une ligne par opération :
//     action UPDATE : modification faite par le root admin (anciennes et
//       nouvelles valeurs des champs réellement modifiés, `changes`) ;
//     action DELETE : toute suppression, copie intégrale de la fiche (enfants
//       inclus) prise juste avant la suppression (`snapshot`).
//   lockOverride : vrai si la fiche était validée (verrouillée) et n'a pu être
//   modifiée / supprimée qu'au titre de l'exception root admin.
module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        "production_fiche_audit",
        {
          id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
          ficheType: { type: Sequelize.STRING(10), allowNull: false },
          ficheId: { type: Sequelize.UUID, allowNull: false },
          ficheNumber: { type: Sequelize.STRING(50), allowNull: true },
          action: { type: Sequelize.STRING(10), allowNull: false },
          userId: { type: Sequelize.UUID, allowNull: true },
          userEmail: { type: Sequelize.STRING(255), allowNull: true },
          userRole: { type: Sequelize.STRING(50), allowNull: true },
          lockOverride: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
          changes: { type: Sequelize.JSONB, allowNull: true },
          snapshot: { type: Sequelize.JSONB, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
        },
        { transaction: t }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE production_fiche_audit
           ADD CONSTRAINT production_fiche_audit_type_chk CHECK ("ficheType" IN ('PROMESH', 'PROBAR')),
           ADD CONSTRAINT production_fiche_audit_action_chk CHECK (action IN ('UPDATE', 'DELETE'))`,
        { transaction: t }
      );
      await queryInterface.addIndex("production_fiche_audit", ["ficheType", "ficheId"], { name: "production_fiche_audit_fiche_idx", transaction: t });
      await queryInterface.addIndex("production_fiche_audit", ["createdAt"], { name: "production_fiche_audit_created_idx", transaction: t });
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    // Refusé (sans rien supprimer) dès qu'une opération est journalisée :
    // les copies des fiches supprimées n'existent nulle part ailleurs.
    const [[{ n }]] = await queryInterface.sequelize.query(`SELECT count(*)::int AS n FROM production_fiche_audit`);
    if (n > 0) throw new Error(`${n} opération(s) journalisée(s) : annulation refusée pour préserver l'audit.`);
    await queryInterface.dropTable("production_fiche_audit");
  },
};
