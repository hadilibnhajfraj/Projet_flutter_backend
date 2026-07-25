"use strict";

// Backfill historique : pour tout contact sans commercialId, si son
// créateur (createdBy) est un utilisateur au rôle "commercial" (au sens
// large — voir constants/commercialRoles.js NON_COMMERCIAL_ROLES, dupliqué
// ici en SQL car les migrations ne peuvent pas requérir le code applicatif),
// on l'affecte automatiquement à ce même créateur. Idempotent (WHERE
// "commercialId" IS NULL) — rejouable sans effet de bord.
const NON_COMMERCIAL_ROLES = [
  "admin",
  "superadmin",
  "superadmin2",
  "responsable_logistique_achat",
  "accueil",
];

module.exports = {
  async up(queryInterface) {
    const rolesList = NON_COMMERCIAL_ROLES.map((r) => `'${r}'`).join(", ");

    const [, meta] = await queryInterface.sequelize.query(`
      UPDATE commercial_contacts cc
      SET "commercialId" = cc."createdBy"
      FROM users u
      WHERE cc."commercialId" IS NULL
        AND cc."createdBy" = u.id
        AND u.role NOT IN (${rolesList});
    `);

    console.log(
      `[backfill-commercial-id] Contacts mis à jour : ${meta?.rowCount ?? "?"}`
    );
  },

  // Pas de rollback destructif : on ne sait pas distinguer, après coup, les
  // commercialId posés par ce backfill de ceux posés manuellement via
  // l'action "Affecter des contacts" — down() est un no-op volontaire.
  async down() {},
};
