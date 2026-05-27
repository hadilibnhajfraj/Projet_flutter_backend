"use strict";

// Backfills ownerId for every project that has no owner assigned yet.
// Strategy: use the user_projects row where permission = 'owner' as the source
// of truth, since this row is always created at project creation time.
//
// Safe to re-run — WHERE "ownerId" IS NULL ensures already-fixed rows are skipped.

module.exports = {
  async up(queryInterface) {
    // Step 1: backfill from the user_projects "owner" link
    await queryInterface.sequelize.query(`
      UPDATE projects p
      SET    "ownerId"   = up."userId",
             "updatedAt" = NOW()
      FROM   user_projects up
      WHERE  up."projectId" = p.id
        AND  up.permission   = 'owner'
        AND  p."ownerId"    IS NULL;
    `);

    // Step 2: log how many rows remain unfixed (for monitoring)
    const [[{ remaining }]] = await queryInterface.sequelize.query(`
      SELECT COUNT(*)::int AS remaining
      FROM projects
      WHERE "ownerId" IS NULL;
    `);

    if (remaining > 0) {
      console.warn(
        `[backfill-owner-id] ${remaining} project(s) still have ownerId = NULL ` +
        `(no matching user_projects row with permission='owner').`
      );
    } else {
      console.log("[backfill-owner-id] All projects now have an ownerId. ✓");
    }
  },

  async down() {
    // Intentionally a no-op — reverting a data backfill could destroy real data.
  },
};
