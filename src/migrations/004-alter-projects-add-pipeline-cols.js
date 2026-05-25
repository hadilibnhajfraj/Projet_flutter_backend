"use strict";

// Maps legacy pipelineStage ENUM values to the stage names seeded by the pipeline-stages seeder.
// Run AFTER 001, 002, 003 and AFTER seeding pipeline_stages.

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable("projects");

    // 1. Add pipelineStageId if missing
    if (!tableDesc.pipelineStageId) {
      await queryInterface.addColumn("projects", "pipelineStageId", {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "pipeline_stages", key: "id" },
        onDelete: "SET NULL",
        onUpdate: "CASCADE",
      });
      await queryInterface.addIndex("projects", ["pipelineStageId"]);
    }

    // 2. Add ownerId if missing
    if (!tableDesc.ownerId) {
      await queryInterface.addColumn("projects", "ownerId", {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
        onUpdate: "CASCADE",
      });
      await queryInterface.addIndex("projects", ["ownerId"]);
    }

    // 3. Migrate existing pipelineStage ENUM values → pipelineStageId FK
    //    Only runs if legacy pipelineStage column still exists
    if (tableDesc.pipelineStage) {
      const legacyMap = {
        Prospect: "Prospect",
        "Contacté": "Contacté",
        Visite: "Site Visit",
        "Devis envoyé": "Quote Sent",
        Negociation: "Negotiation",
        "Gagné": "Won",
        Perdu: "Lost",
      };

      for (const [legacyValue, stageName] of Object.entries(legacyMap)) {
        await queryInterface.sequelize.query(
          `UPDATE projects
           SET "pipelineStageId" = ps.id
           FROM pipeline_stages ps
           WHERE ps.name = :stageName
             AND projects."pipelineStage" = :legacyValue
             AND projects."pipelineStageId" IS NULL`,
          { replacements: { stageName, legacyValue } }
        );
      }

      // Rename legacy column to preserve data instead of hard-dropping
      await queryInterface.renameColumn("projects", "pipelineStage", "pipelineStage_legacy");
    }
  },

  async down(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable("projects");

    if (tableDesc.pipelineStageId) {
      await queryInterface.removeColumn("projects", "pipelineStageId");
    }
    if (tableDesc.ownerId) {
      await queryInterface.removeColumn("projects", "ownerId");
    }
    if (tableDesc.pipelineStage_legacy) {
      await queryInterface.renameColumn("projects", "pipelineStage_legacy", "pipelineStage");
    }
  },
};
