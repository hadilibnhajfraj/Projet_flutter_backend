"use strict";

/**
 * Standalone action-types seeder.
 * Inserts the 5 core action types (and legacy ones) idempotently.
 * Safe to run multiple times — skips rows whose name already exists.
 *
 * Usage (via migration runner):
 *   node src/scripts/run-pipeline-migration.js
 *
 * Usage (via sequelize-cli):
 *   npx sequelize-cli db:seed --seed src/seeders/action-types.seeder.js
 */

const ACTION_TYPES = [
  // ── Core types (requested) ────────────────────────────
  { name: "Site Visit",      color: "#a78bfa", icon: "map-pin"     },
  { name: "Technical Plan",  color: "#818cf8", icon: "file-text"   },
  { name: "Sampling",        color: "#f59e0b", icon: "package"     },
  { name: "Negotiation",     color: "#f97316", icon: "trending-up" },
  { name: "Quote Sent",      color: "#fb923c", icon: "send"        },
  // ── Legacy types (migrated from old typeAction ENUM) ──
  { name: "Visite",          color: "#94a3b8", icon: "map-pin"     },
  { name: "Plan technique",  color: "#818cf8", icon: "file-text"   },
  { name: "Echantillonnage", color: "#f59e0b", icon: "package"     },
  { name: "Devis envoyé",    color: "#fb923c", icon: "send"        },
  { name: "Negociation",     color: "#f97316", icon: "trending-up" },
  { name: "Relance",         color: "#60a5fa", icon: "bell"        },
  { name: "Commande gagnée", color: "#22c55e", icon: "check-circle"},
  { name: "Commande perdue", color: "#ef4444", icon: "x-circle"    },
  { name: "Fidelisation",    color: "#ec4899", icon: "heart"       },
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    for (const type of ACTION_TYPES) {
      const [existing] = await queryInterface.sequelize.query(
        `SELECT id FROM project_action_types WHERE name = :name LIMIT 1`,
        { replacements: { name: type.name }, type: "SELECT" }
      );

      if (!existing) {
        await queryInterface.sequelize.query(
          `INSERT INTO project_action_types
             (id, name, color, icon, "createdAt", "updatedAt")
           VALUES
             (gen_random_uuid(), :name, :color, :icon, :now, :now)`,
          { replacements: { ...type, now } }
        );
        console.log(`      + ActionType: "${type.name}" created`);
      } else {
        console.log(`      ~ ActionType: "${type.name}" already exists — skipped`);
      }
    }
  },

  async down(queryInterface) {
    const names = ACTION_TYPES.map((t) => `'${t.name.replace(/'/g, "''")}'`).join(",");
    await queryInterface.sequelize.query(
      `DELETE FROM project_action_types WHERE name IN (${names})`
    );
  },
};
