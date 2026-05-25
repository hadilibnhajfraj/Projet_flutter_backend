"use strict";

// Maps legacy typeAction ENUM values → project_action_types rows (seeded).
// Run AFTER 002 and AFTER seeding project_action_types.

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable("project_actions");

    // 1. Add actionTypeId if missing
    if (!tableDesc.actionTypeId) {
      await queryInterface.addColumn("project_actions", "actionTypeId", {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "project_action_types", key: "id" },
        onDelete: "SET NULL",
        onUpdate: "CASCADE",
      });
      await queryInterface.addIndex("project_actions", ["actionTypeId"]);
    }

    // 2. Migrate legacy typeAction values → actionTypeId
    if (tableDesc.typeAction) {
      const legacyActionMap = [
        "Visite",
        "Plan technique",
        "Echantillonnage",
        "Devis envoyé",
        "Negociation",
        "Relance",
        "Commande gagnée",
        "Commande perdue",
        "Fidelisation",
      ];

      for (const actionName of legacyActionMap) {
        // Ensure action type exists (upsert)
        await queryInterface.sequelize.query(
          `INSERT INTO project_action_types (id, name, color, "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), :name, '#6366f1', NOW(), NOW())
           ON CONFLICT (name) DO NOTHING`,
          { replacements: { name: actionName } }
        );

        await queryInterface.sequelize.query(
          `UPDATE project_actions
           SET "actionTypeId" = pat.id
           FROM project_action_types pat
           WHERE pat.name = :name
             AND project_actions."typeAction" = :name
             AND project_actions."actionTypeId" IS NULL`,
          { replacements: { name: actionName } }
        );
      }

      // Rename legacy column instead of dropping
      await queryInterface.renameColumn("project_actions", "typeAction", "typeAction_legacy");
    }
  },

  async down(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable("project_actions");

    if (tableDesc.actionTypeId) {
      await queryInterface.removeColumn("project_actions", "actionTypeId");
    }
    if (tableDesc.typeAction_legacy) {
      await queryInterface.renameColumn("project_actions", "typeAction_legacy", "typeAction");
    }
  },
};
