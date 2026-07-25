"use strict";

// Le module "Maintenance" existait déjà sous forme de lignes industrial_records
// (module='maintenance', créées via l'ancien écran PRODUCTION > MAINTENANCE >
// Nouvelle demande). Ces lignes ne sont pas visibles dans le nouveau workflow
// ADMINISTRATION > Demandes > Maintenance, qui lit exclusivement
// maintenance_requests — d'où l'incohérence "Historique" (2 fiches) vs
// "Demandes > Maintenance" (0 demande). On copie ces fiches historiques vers
// maintenance_requests une seule fois (idempotent via NOT EXISTS sur
// userId+machine+typePanne+dateFiche pour ne jamais dupliquer si la migration
// est rejouée).

module.exports = {
  async up(queryInterface) {
    const [result] = await queryInterface.sequelize.query(`
      INSERT INTO maintenance_requests
        (id, "userId", equipement, "typePanne", urgence, description, photos, statut, "createdAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        ir."createdBy",
        ir.machine,
        ir."typePanne",
        COALESCE(NULLIF(ir.urgence::text, ''), 'moyenne')::"enum_maintenance_requests_urgence",
        COALESCE(ir.description, ''),
        '[]'::jsonb,
        'en_attente'::"enum_maintenance_requests_statut",
        ir."createdAt",
        ir."updatedAt"
      FROM industrial_records ir
      WHERE ir.module = 'maintenance'
        AND ir."createdBy" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_requests mr
          WHERE mr."userId" = ir."createdBy"
            AND mr.equipement = ir.machine
            AND mr."typePanne" = ir."typePanne"
            AND mr."createdAt" = ir."createdAt"
        )
    `);

    console.log(`[MIGRATION] legacy maintenance industrial_records backfilled into maintenance_requests: ${result.rowCount ?? "n/a"} row(s)`);
  },

  async down() {
    // Non destructif — ne pas retirer les fiches migrées.
  },
};
