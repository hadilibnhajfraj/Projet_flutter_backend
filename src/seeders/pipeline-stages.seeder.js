"use strict";

const { v4: uuidv4 } = require("uuid");

const STAGES = [
  { name: "Prospect",          color: "#94a3b8", icon: "search",         position: 0,  isDefault: true,  isWonStage: false, isLostStage: false, autoCreateAction: false },
  { name: "Contacté",          color: "#60a5fa", icon: "phone",          position: 1,  isDefault: false, isWonStage: false, isLostStage: false, autoCreateAction: true  },
  { name: "Site Visit",        color: "#a78bfa", icon: "map-pin",        position: 2,  isDefault: false, isWonStage: false, isLostStage: false, autoCreateAction: true  },
  { name: "Plan technique",    color: "#818cf8", icon: "file-text",      position: 3,  isDefault: false, isWonStage: false, isLostStage: false, autoCreateAction: true  },
  { name: "Echantillonnage",   color: "#f59e0b", icon: "package",        position: 4,  isDefault: false, isWonStage: false, isLostStage: false, autoCreateAction: true  },
  { name: "Quote Sent",        color: "#fb923c", icon: "send",           position: 5,  isDefault: false, isWonStage: false, isLostStage: false, autoCreateAction: true  },
  { name: "Negotiation",       color: "#f97316", icon: "trending-up",    position: 6,  isDefault: false, isWonStage: false, isLostStage: false, autoCreateAction: false },
  { name: "Won",               color: "#22c55e", icon: "check-circle",   position: 7,  isDefault: false, isWonStage: true,  isLostStage: false, autoCreateAction: false },
  { name: "Lost",              color: "#ef4444", icon: "x-circle",       position: 8,  isDefault: false, isWonStage: false, isLostStage: true,  autoCreateAction: false },
  { name: "Loyalty",           color: "#ec4899", icon: "heart",          position: 9,  isDefault: false, isWonStage: false, isLostStage: false, autoCreateAction: true  },
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    for (const stage of STAGES) {
      // Idempotent — skip if stage name already exists
      const [existing] = await queryInterface.sequelize.query(
        `SELECT id FROM pipeline_stages WHERE name = :name LIMIT 1`,
        { replacements: { name: stage.name }, type: "SELECT" }
      );

      let stageId;

      if (!existing) {
        stageId = uuidv4();
        await queryInterface.sequelize.query(
          `INSERT INTO pipeline_stages
             (id, name, color, icon, position, "isDefault", "isWonStage", "isLostStage", "autoCreateAction", "createdAt", "updatedAt")
           VALUES
             (:id, :name, :color, :icon, :position, :isDefault, :isWonStage, :isLostStage, :autoCreateAction, :now, :now)`,
          {
            replacements: { id: stageId, ...stage, now },
          }
        );
        console.log(`    + Stage: "${stage.name}" created`);
      } else {
        stageId = existing.id;
        console.log(`    ~ Stage: "${stage.name}" already exists — skipped`);
      }

      // Auto-create linked action type if stage has autoCreateAction
      if (stage.autoCreateAction) {
        const actionName = `Action - ${stage.name}`;
        const [existingType] = await queryInterface.sequelize.query(
          `SELECT id FROM project_action_types WHERE name = :name LIMIT 1`,
          { replacements: { name: actionName }, type: "SELECT" }
        );

        if (!existingType) {
          await queryInterface.sequelize.query(
            `INSERT INTO project_action_types
               (id, name, color, icon, "linkedStageId", "createdAt", "updatedAt")
             VALUES
               (gen_random_uuid(), :name, :color, :icon, :linkedStageId, :now, :now)`,
            {
              replacements: {
                name: actionName,
                color: stage.color,
                icon: stage.icon,
                linkedStageId: stageId,
                now,
              },
            }
          );
          console.log(`      + ActionType: "${actionName}" created`);
        }
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM project_action_types WHERE name LIKE 'Action - %'`
    );
    await queryInterface.sequelize.query(
      `DELETE FROM pipeline_stages WHERE name IN (${STAGES.map((s) => `'${s.name}'`).join(",")})`
    );
  },
};
