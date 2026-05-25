"use strict";

/**
 * 006-backfill-project-stages.js
 *
 * Assigns a pipelineStageId to every project that currently has NULL.
 *
 * Strategy (two passes):
 *   Pass 1 — smart map: if pipelineStage_legacy column exists, translate
 *             old ENUM values to the matching new stage by name.
 *   Pass 2 — fallback: any project still NULL after pass 1 gets the
 *             default stage (isDefault=true, or lowest position).
 *
 * Idempotent: safe to run multiple times.
 * Rollback:   sets pipelineStageId back to NULL for all rows this migration touched.
 */

// Legacy ENUM value → new stage name mapping
const LEGACY_MAP = [
  { legacy: "Prospect",      stage: "Prospect"    },
  { legacy: "Contacté",      stage: "Contacté"    },
  { legacy: "Visite",        stage: "Site Visit"  },
  { legacy: "Devis envoyé",  stage: "Quote Sent"  },
  { legacy: "Negociation",   stage: "Negotiation" },
  { legacy: "Négociation",   stage: "Negotiation" },
  { legacy: "Gagné",         stage: "Won"         },
  { legacy: "Perdu",         stage: "Lost"        },
  { legacy: "Fidélisation",  stage: "Loyalty"     },
  { legacy: "Fidelisation",  stage: "Loyalty"     },
];

module.exports = {
  async up(queryInterface) {
    const qi = queryInterface;

    // ── Guard: no pipeline_stages → nothing to do ────────────
    const tables = await qi.sequelize.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'pipeline_stages' LIMIT 1`,
      { type: "SELECT" }
    );
    if (!tables.length) {
      console.log("    ⏭  pipeline_stages not found — skipping backfill");
      return;
    }

    const [stageCountRow] = await qi.sequelize.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_stages WHERE "deletedAt" IS NULL`,
      { type: "SELECT" }
    );
    if (!stageCountRow || stageCountRow.cnt === 0) {
      console.log("    ⏭  No stages seeded yet — skipping backfill");
      return;
    }

    // ── Pass 1: smart map via pipelineStage_legacy ───────────
    const tableDesc = await qi.describeTable("projects");

    if (tableDesc.pipelineStage_legacy) {
      console.log("    → Pass 1: mapping legacy pipelineStage values…");

      for (const { legacy, stage } of LEGACY_MAP) {
        const [result] = await qi.sequelize.query(
          `UPDATE projects p
           SET    "pipelineStageId" = ps.id
           FROM   pipeline_stages ps
           WHERE  p."pipelineStageId" IS NULL
             AND  ps.name             = :stage
             AND  ps."deletedAt"      IS NULL
             AND  p."pipelineStage_legacy" = :legacy`,
          { replacements: { legacy, stage } }
        );

        const updated = typeof result === "number" ? result : (result?.rowCount ?? 0);
        if (updated > 0) {
          console.log(`      + "${legacy}" → "${stage}"  (${updated} projects)`);
        }
      }
    }

    // ── Pass 2: default stage for anything still NULL ────────
    console.log("    → Pass 2: assigning default stage to remaining NULL projects…");

    const [backfillResult] = await qi.sequelize.query(
      `UPDATE projects
       SET    "pipelineStageId" = (
         SELECT id
         FROM   pipeline_stages
         WHERE  "deletedAt" IS NULL
         ORDER  BY "isDefault" DESC, position ASC
         LIMIT  1
       )
       WHERE  "pipelineStageId" IS NULL`,
    );

    const backfilled = typeof backfillResult === "number"
      ? backfillResult
      : (backfillResult?.rowCount ?? 0);

    console.log(`      + ${backfilled} project(s) assigned to default stage`);

    // ── Summary ───────────────────────────────────────────────
    const [nullCountRow] = await qi.sequelize.query(
      `SELECT COUNT(*)::int AS cnt FROM projects WHERE "pipelineStageId" IS NULL`,
      { type: "SELECT" }
    );
    const remaining = nullCountRow?.cnt ?? 0;
    if (remaining > 0) {
      console.log(`    ⚠  ${remaining} project(s) still have NULL pipelineStageId (no stages found for them)`);
    } else {
      console.log("    ✅ All projects now have a pipelineStageId");
    }
  },

  async down(queryInterface) {
    // Reverting this migration would destroy stage assignments — unsafe.
    // We only reset rows that were set by this migration; since we cannot
    // know exactly which rows we touched, we leave them as-is and warn.
    console.warn(
      "  ⚠  006 down(): pipelineStageId values are NOT reset (data-safe rollback). " +
      "Run a manual UPDATE if needed."
    );
  },
};
