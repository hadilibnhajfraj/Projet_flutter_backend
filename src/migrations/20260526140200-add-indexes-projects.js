"use strict";

// Performance indexes for the pipeline kanban + paginated list queries.
// Uses raw SQL so each CREATE INDEX can carry IF NOT EXISTS, making the
// migration safe to re-run and idempotent even if some indexes already exist.

module.exports = {
  async up(queryInterface) {
    const run = (sql) => queryInterface.sequelize.query(sql);

    // ── projects table ────────────────────────────────────────────────────
    await run(`CREATE INDEX IF NOT EXISTS idx_projects_pipeline_stage
               ON projects ("pipelineStageId")`);

    await run(`CREATE INDEX IF NOT EXISTS idx_projects_owner
               ON projects ("ownerId")`);

    await run(`CREATE INDEX IF NOT EXISTS idx_projects_archived
               ON projects ("isArchived")`);

    await run(`CREATE INDEX IF NOT EXISTS idx_projects_created_at
               ON projects ("createdAt" DESC)`);

    // Trigram index for fast ILIKE search on project name
    await run(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await run(`CREATE INDEX IF NOT EXISTS idx_projects_nom_trgm
               ON projects USING gin ("nomProjet" gin_trgm_ops)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_projects_entreprise_trgm
               ON projects USING gin ("entreprise" gin_trgm_ops)`);

    // ── project_actions table (already queried heavily) ───────────────────
    await run(`CREATE INDEX IF NOT EXISTS idx_pa_project_date
               ON project_actions ("projectId", "dateAction" DESC)`);
  },

  async down(queryInterface) {
    const run = (sql) => queryInterface.sequelize.query(sql);
    await run(`DROP INDEX IF EXISTS idx_projects_pipeline_stage`);
    await run(`DROP INDEX IF EXISTS idx_projects_owner`);
    await run(`DROP INDEX IF EXISTS idx_projects_archived`);
    await run(`DROP INDEX IF EXISTS idx_projects_created_at`);
    await run(`DROP INDEX IF EXISTS idx_projects_nom_trgm`);
    await run(`DROP INDEX IF EXISTS idx_projects_entreprise_trgm`);
    await run(`DROP INDEX IF EXISTS idx_pa_project_date`);
  },
};
