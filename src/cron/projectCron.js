"use strict";

const cron = require("node-cron");

const { Project, User, UserProject } = require("../models");
const Notification = require("../models/Notification");
const {
  sendRelanceIngenieurEmail,
  sendRelanceEntrepriseEmail,
  sendRelanceBureauControleEmail,
} = require("../utils/sendEmail");

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Auto-archive guard ───────────────────────────────────────────────────────
// Set AUTO_ARCHIVE_ENABLED=true in .env to allow the cron to archive projects.
// Default: DISABLED — projects will only receive reminder notifications.
const AUTO_ARCHIVE_ENABLED = process.env.AUTO_ARCHIVE_ENABLED === "true";

console.log("[CRON] AUTO_ARCHIVE_ENABLED =", AUTO_ARCHIVE_ENABLED);

// ─── Missing field detection ──────────────────────────────────────────────────

function getMissingFields(p) {
  const missing = [];

  if (p.projectModele === "project") {
    if (!p.ingenieurResponsable) missing.push("ingenieur");
  }

  if (p.projectModele === "revendeur") {
    if (!p.comptoir)          missing.push("comptoir");
    if (!p.telephoneComptoir) missing.push("tel_comptoir");
  }

  if (p.projectModele === "applicateur") {
    if (!p.dallagiste)          missing.push("dallagiste");
    if (!p.telephoneDallagiste) missing.push("tel_dallagiste");
  }

  // Common to all types
  if (!p.entreprise)    missing.push("entreprise");
  if (!p.bureauControle) missing.push("bureau");

  return missing;
}

// ─── Auto-archive function ────────────────────────────────────────────────────
// Only runs when AUTO_ARCHIVE_ENABLED=true.
// Threshold: 30 days (was 7 — too aggressive for active CRM projects).

const ARCHIVE_THRESHOLD_DAYS = parseInt(process.env.ARCHIVE_THRESHOLD_DAYS || "30", 10);

async function archiveProjects(projects) {
  if (!AUTO_ARCHIVE_ENABLED) {
    console.log("[CRON] Auto-archive is DISABLED — skipping archiving step.");
    return;
  }

  const now = new Date();
  let archivedCount = 0;

  for (const p of projects) {
    try {
      if (p.isArchived) continue;

      const createdAt  = new Date(p.createdAt);
      const diffDays   = Math.floor((now - createdAt) / DAY_MS);
      const missingFields = getMissingFields(p);
      const isIncomplete  = missingFields.length > 0;

      if (isIncomplete && diffDays >= ARCHIVE_THRESHOLD_DAYS) {
        console.log("ARCHIVE_TRIGGER");
        console.log("PROJECT_ID", p.id);
        console.log("PROJECT_NAME", p.nomProjet);
        console.log("OWNER_ID", p.ownerId);
        console.log("REASON", `Missing fields after ${diffDays} days: ${missingFields.join(", ")}`);

        p.isArchived    = true;
        p.archivedAt    = now;
        p.archiveReason = `Auto-archivé : champs manquants (${missingFields.join(", ")}) après ${diffDays} jours`;

        await p.save();
        archivedCount++;

        console.log(`[CRON] Archived: ${p.nomProjet} (${diffDays}d, missing: ${missingFields.join(", ")})`);
      }
    } catch (e) {
      console.error("[CRON] ARCHIVE ERROR:", e.message, "project:", p?.id);
    }
  }

  console.log(`[CRON] archiveProjects done — ${archivedCount} projects archived.`);
}

// ─── Main cron function ───────────────────────────────────────────────────────

async function checkProjects() {
  try {
    console.log("⏰ CRON START");

    const projects = await Project.findAll({
      where: { isArchived: false },
      include: [{ model: UserProject, include: [User] }],
    });

    console.log("📁 Projects to check:", projects.length);

    const now = new Date();

    for (const p of projects) {
      const owner  = p.UserProjects?.find((u) => u.permission === "owner");
      const email  = owner?.User?.email;
      const userId = owner?.User?.id;

      if (!email || !userId) continue;

      const missingFields = getMissingFields(p);
      const createdAt     = new Date(p.createdAt);
      const diffDays      = Math.floor((now - createdAt) / DAY_MS);
      const last          = p.lastRelanceAt ? new Date(p.lastRelanceAt) : null;
      const alreadyToday  = last && last.toDateString() === now.toDateString();

      // Send reminder notification if fields are missing AND no relance was sent today
      if (missingFields.length > 0 && !alreadyToday && diffDays < ARCHIVE_THRESHOLD_DAYS) {
        console.log(`📧 RELANCE ${p.projectModele?.toUpperCase()} | ${p.nomProjet} | missing: ${missingFields.join(", ")}`);

        let message = `Relance pour projet ${p.nomProjet}`;

        try {
          if (missingFields.includes("ingenieur")) {
            await sendRelanceIngenieurEmail(email, p);
            message = `Projet ${p.nomProjet} sans ingénieur`;
          }
          if (missingFields.includes("comptoir") || missingFields.includes("tel_comptoir")) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Informations comptoir manquantes (${p.nomProjet})`;
          }
          if (missingFields.includes("dallagiste") || missingFields.includes("tel_dallagiste")) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Informations dallagiste manquantes (${p.nomProjet})`;
          }
          if (missingFields.includes("entreprise")) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Entreprise manquante (${p.nomProjet})`;
          }
          if (missingFields.includes("bureau")) {
            await sendRelanceBureauControleEmail(email, p);
            message = `Bureau de contrôle manquant (${p.nomProjet})`;
          }

          await Notification.create({
            userId,
            type:      "PROJECT_RELANCE",
            title:     "Relance projet",
            message,
            projectId: p.id,
            isRead:    false,
          });

          p.lastRelanceAt = now;
          await p.save();

        } catch (err) {
          console.error("❌ EMAIL ERROR:", err.message);
          await Notification.create({
            userId,
            type:      "PROJECT_ERROR",
            title:     "Erreur relance",
            message:   `Erreur envoi pour ${p.nomProjet}`,
            projectId: p.id,
            isRead:    false,
          }).catch(() => {});
        }
      }
    }

    // Archive step — only runs when AUTO_ARCHIVE_ENABLED=true
    await archiveProjects(projects);

    console.log("✅ CRON END");
  } catch (e) {
    console.error("❌ CRON ERROR:", e.message);
  }
}

// ─── Schedule (every day at 08:00) ───────────────────────────────────────────
cron.schedule("0 8 * * *", checkProjects);

module.exports = { checkProjects };
