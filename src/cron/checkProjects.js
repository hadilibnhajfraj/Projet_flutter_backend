"use strict";

const cron = require("node-cron");
const { Op } = require("sequelize");
const Project = require("../models/Project");
const sendEmail = require("../utils/sendEmail");

// ─── Auto-archive guard ───────────────────────────────────────────────────────
// Mirrors the flag in projectCron.js — both must be enabled independently.
const AUTO_ARCHIVE_ENABLED = process.env.AUTO_ARCHIVE_ENABLED === "true";

// Runs every hour: check for projects whose engineer deadline has passed.
cron.schedule("0 * * * *", async () => {
  console.log("⏳ [checkProjects] Vérification des projets...");

  if (!AUTO_ARCHIVE_ENABLED) {
    console.log("[checkProjects] AUTO_ARCHIVE_ENABLED=false — archiving skipped.");
    return;
  }

  const now = new Date();

  const projects = await Project.findAll({
    where: {
      isArchived:          false,
      ingenieurResponsable: null,
      dateLimiteIngenieur: { [Op.lte]: now },
    },
  });

  console.log(`[checkProjects] ${projects.length} project(s) past engineer deadline.`);

  for (const p of projects) {
    try {
      console.log("ARCHIVE_TRIGGER");
      console.log("PROJECT_ID",   p.id);
      console.log("PROJECT_NAME", p.nomProjet);
      console.log("OWNER_ID",     p.ownerId);
      console.log("REASON",       "ingenieurResponsable manquant après dateLimiteIngenieur");

      await sendEmail({
        to:      p.emailIngenieur || "admin@crmprobar.com",
        subject: "⚠️ Relance projet",
        text:    `Le projet ${p.nomProjet} n'a pas d'ingénieur après la date limite.`,
      });

      await p.update({
        isArchived:    true,
        archivedAt:    new Date(),
        archiveReason: "Auto-archivé : ingénieur manquant après la date limite",
      });

      console.log(`[checkProjects] Archived: ${p.nomProjet}`);
    } catch (e) {
      console.error("[checkProjects] ERROR:", e.message, "project:", p?.id);
    }
  }
});
