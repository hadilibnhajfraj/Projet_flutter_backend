"use strict";

// Backfills adminId on all archive_requests rows where adminId is NULL.
// Assigns the first superadmin found. Safe to re-run (WHERE adminId IS NULL guard).

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      `SELECT id FROM users WHERE role = 'superadmin' ORDER BY "createdAt" ASC LIMIT 1`
    );

    if (!rows.length) {
      console.warn("[MIGRATION] No superadmin found — skipping archive_requests backfill");
      return;
    }

    const superadminId = rows[0].id;

    const [result] = await queryInterface.sequelize.query(
      `UPDATE archive_requests SET "adminId" = :adminId WHERE "adminId" IS NULL`,
      { replacements: { adminId: superadminId } }
    );

    console.log(`[MIGRATION] archive_requests backfill: ${result} rows updated with adminId = ${superadminId}`);
  },

  async down() {
    // Non-destructive — do not undo backfill
  },
};
