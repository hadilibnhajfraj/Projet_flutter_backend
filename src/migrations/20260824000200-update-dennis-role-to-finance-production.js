"use strict";

// §MODIFICATION — INTERFACE PRODUCTION DE DENNISREDFEATHER : migre
// dennisredfeather@gmail.com de "finance_probar" vers "finance_production"
// (nouveau rôle ajouté par 20260824000100). Scope volontairement restreint à
// `role = 'finance_probar'` (son rôle connu au moment de ce ticket) — si le
// rôle a déjà été changé manuellement entre-temps, cette migration ne
// l'écrase pas.
//
// Doit s'exécuter APRÈS 20260824000100 (la valeur d'ENUM doit exister).
// Idempotent : ré-exécuter ce script ne fait rien après la première fois
// (plus aucune ligne ne correspond au WHERE).

const EMAIL = "dennisredfeather@gmail.com";
const OLD_ROLE = "finance_probar";
const NEW_ROLE = "finance_production";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE users SET role = :newRole, "updatedAt" = NOW()
       WHERE email = :email AND role = :oldRole`,
      { replacements: { email: EMAIL, oldRole: OLD_ROLE, newRole: NEW_ROLE } }
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE users SET role = :oldRole, "updatedAt" = NOW()
       WHERE email = :email AND role = :newRole`,
      { replacements: { email: EMAIL, oldRole: OLD_ROLE, newRole: NEW_ROLE } }
    );
  },
};
