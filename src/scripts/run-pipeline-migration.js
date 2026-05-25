/**
 * run-pipeline-migration.js
 *
 * Standalone, idempotent migration runner — does NOT require sequelize-cli.
 * Safe to run multiple times — each step checks before acting.
 *
 * Usage:
 *   node src/scripts/run-pipeline-migration.js
 *
 * Steps:
 *   1. Create pipeline_stages
 *   2. Create project_action_types
 *   3. Create project_activities
 *   4. Seed pipeline stages + auto-linked action types
 *   5. Seed standalone action types (Site Visit, Technical Plan, …)
 *   6. Migrate projects        → add pipelineStageId + ownerId
 *   7. Migrate project_actions → add actionTypeId
 *   8. Backfill pipelineStageId → assign default stage to all NULL rows
 */

require("dotenv").config();
const { sequelize } = require("../db");
const m001 = require("../migrations/001-create-pipeline-stages");
const m002 = require("../migrations/002-create-project-action-types");
const m003 = require("../migrations/003-create-project-activities");
const m004 = require("../migrations/004-alter-projects-add-pipeline-cols");
const m005 = require("../migrations/005-alter-project-actions-add-action-type");
const m006 = require("../migrations/006-backfill-project-stages");
const pipelineStagesSeeder = require("../seeders/pipeline-stages.seeder");
const actionTypesSeeder    = require("../seeders/action-types.seeder");

// ── Helpers ───────────────────────────────────────────────

async function tableExists(tableName) {
  const [row] = await sequelize.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    { bind: [tableName], type: sequelize.QueryTypes.SELECT }
  );
  return Boolean(row);
}

async function step(label, fn) {
  process.stdout.write(`  ${label} … `);
  try {
    await fn();
    console.log("✅");
  } catch (e) {
    const alreadyDone =
      e.message?.includes("already exists") ||
      e.message?.includes("duplicate column") ||
      e.original?.code === "42P07"; // PostgreSQL: relation already exists
    if (alreadyDone) {
      console.log("⏭  (already done)");
    } else {
      console.log("❌");
      throw e;
    }
  }
}

// ── Main ──────────────────────────────────────────────────

async function run() {
  const qi = sequelize.getQueryInterface();

  console.log("\n🚀  Pipeline migration starting…\n");

  // 1. pipeline_stages ────────────────────────────────────
  await step("[1/8] Create pipeline_stages", async () => {
    if (await tableExists("pipeline_stages")) throw new Error("already exists");
    await m001.up(qi, sequelize.constructor);
  });

  // 2. project_action_types ───────────────────────────────
  await step("[2/8] Create project_action_types", async () => {
    if (await tableExists("project_action_types")) throw new Error("already exists");
    await m002.up(qi, sequelize.constructor);
  });

  // 3. project_activities ─────────────────────────────────
  await step("[3/8] Create project_activities", async () => {
    if (await tableExists("project_activities")) throw new Error("already exists");
    await m003.up(qi, sequelize.constructor);
  });

  // 4. Seed pipeline stages + auto-linked action types ────
  await step("[4/8] Seed pipeline stages & auto action types",
    () => pipelineStagesSeeder.up(qi, sequelize.constructor)
  );

  // 5. Seed standalone action types ───────────────────────
  await step("[5/8] Seed standalone action types",
    () => actionTypesSeeder.up(qi, sequelize.constructor)
  );

  // 6. Add pipelineStageId + ownerId to projects ──────────
  await step("[6/8] Migrate projects → pipelineStageId / ownerId",
    () => m004.up(qi, sequelize.constructor)
  );

  // 7. Add actionTypeId to project_actions ────────────────
  await step("[7/8] Migrate project_actions → actionTypeId",
    () => m005.up(qi, sequelize.constructor)
  );

  // 8. Backfill NULL pipelineStageId rows ─────────────────
  console.log("  [8/8] Backfill pipelineStageId for NULL projects…");
  await m006.up(qi, sequelize.constructor);
  console.log("  ✅ Backfill complete\n");

  // ── Invalidate in-process default-stage cache ──────────
  try {
    const Project = require("../models/Project");
    Project.invalidateDefaultStageCache?.();
  } catch { /* model may not be loaded in migration context */ }

  console.log("🎉  Pipeline migration completed successfully!\n");
  await sequelize.close();
  process.exit(0);
}

run().catch((err) => {
  console.error("\n❌  Migration failed:", err.message || err);
  console.error(err);
  process.exit(1);
});
