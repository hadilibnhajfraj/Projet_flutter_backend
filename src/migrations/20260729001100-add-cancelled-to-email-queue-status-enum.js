"use strict";

// Ajoute "CANCELLED" à l'ENUM enum_email_queue_status — utilisé quand un job
// MFA encore PENDING/RETRYING devient inutile (code validé avant que l'envoi
// n'ait abouti, voir services/mfa.service.js `cancelJob`). Distinct de
// FAILED : ce n'est pas un échec, l'annulation est volontaire.
//
// ALTER TYPE … ADD VALUE ne peut pas s'exécuter dans une transaction sur
// PostgreSQL < 12 — même approche que les migrations existantes
// (20260622090000-add-responsable-logistique-achat-to-users-role-enum.js).
//
// PostgreSQL ne permet pas de retirer une valeur d'ENUM : down() est un no-op.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_email_queue_status" ADD VALUE IF NOT EXISTS 'CANCELLED'`
    );
  },

  async down() {
    // Intentional no-op: PostgreSQL cannot drop individual ENUM values.
  },
};
