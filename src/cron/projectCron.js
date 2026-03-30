const cron = require("node-cron");

const { Project, User, UserProject } = require("../models");

const {
  sendRelanceIngenieurEmail,
  sendRelanceEntrepriseEmail,
  sendRelanceBureauControleEmail,
} = require("../utils/sendEmail");

const DAY_MS = 24 * 60 * 60 * 1000;

// =========================
// 📦 ARCHIVAGE
// =========================
async function archiveProjects(projects) {
  const now = new Date();

  for (const p of projects) {
    try {
      if (p.isArchived) continue;

      const createdAt = new Date(p.createdAt);
      const diffDays = Math.floor((now - createdAt) / DAY_MS);

      const isIncomplete =
        !p.ingenieurResponsable ||
        !p.entreprise ||
        !p.bureauControle;

      if (isIncomplete && diffDays >= 7) {
        p.isArchived = true;
        p.archivedAt = now;

        await p.save();

        console.log("📦 ARCHIVED:", p.nomProjet, "| Days:", diffDays);
      }
    } catch (e) {
      console.error("❌ ARCHIVE ERROR:", e.message);
    }
  }
}

// =========================
// 🔥 CRON PRINCIPAL
// =========================
async function checkProjects() {
  try {
    console.log("⏰ CRON START");

    const projects = await Project.findAll({
      where: { isArchived: false },
      include: [
        {
          model: UserProject,
          include: [User],
        },
      ],
    });

    console.log("📁 Projects:", projects.length);

    const now = new Date();

    for (const p of projects) {
      const owner = p.UserProjects?.find(
        (u) => u.permission === "owner"
      );

      const email = owner?.User?.email;
      if (!email) continue;

      // =========================
      // 🔥 CHAMPS MANQUANTS
      // =========================
      const missingFields = [];

     // 🔥 ingenieur seulement pour project
if (p.projectModele === "project" && !p.ingenieurResponsable) {
  missingFields.push("ingenieur");
}
      if (!p.entreprise) missingFields.push("entreprise");
      if (!p.bureauControle) missingFields.push("bureau");

      const createdAt = new Date(p.createdAt);
      const diffDays = Math.floor((now - createdAt) / DAY_MS);

      // =========================
      // 🚫 PAS DE SPAM (1 fois/jour)
      // =========================
      const last = p.lastRelanceAt ? new Date(p.lastRelanceAt) : null;

      const alreadyToday =
        last && last.toDateString() === now.toDateString();

      // =========================
      // 📧 RELANCE INTELLIGENTE
      // =========================
      if (missingFields.length > 0 && !alreadyToday && diffDays < 7) {

        console.log("📧 RELANCE:", p.nomProjet, "| Missing:", missingFields);

       if (
  p.projectModele === "project" &&
  missingFields.includes("ingenieur")
) {
  await sendRelanceIngenieurEmail(email, p);
}

        if (missingFields.includes("entreprise")) {
          await sendRelanceEntrepriseEmail(email, p);
        }

        if (missingFields.includes("bureau")) {
          await sendRelanceBureauControleEmail(email, p);
        }

        // 🔥 sauvegarde date relance
        p.lastRelanceAt = now;
        await p.save();
      }
    }

    // =========================
    // 📦 ARCHIVAGE
    // =========================
    await archiveProjects(projects);

    console.log("✅ CRON END");

  } catch (e) {
    console.error("❌ CRON ERROR:", e.message);
  }
}

// =========================
// ⏰ PLANIFICATION
// =========================

// 🔥 TOUS LES JOURS À 08:00
cron.schedule("0 8 * * *", checkProjects);

module.exports = { checkProjects };