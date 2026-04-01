const cron = require("node-cron");

const { Project, User, UserProject } = require("../models");

const {
  sendRelanceIngenieurEmail,
  sendRelanceEntrepriseEmail,
  sendRelanceBureauControleEmail,
} = require("../utils/sendEmail");

const DAY_MS = 24 * 60 * 60 * 1000;

// =========================
// 🔥 GET MISSING FIELDS (CORE LOGIC)
// =========================
function getMissingFields(p) {
  const missing = [];

  // =========================
  // 🔵 MODE PROJECT
  // =========================
  if (p.projectModele === "project") {
    if (!p.ingenieurResponsable) {
      missing.push("ingenieur");
    }
  }

  // =========================
  // 🟡 MODE REVENDEUR
  // =========================
  if (p.projectModele === "revendeur") {
    if (!p.comptoir) {
      missing.push("comptoir");
    }
    if (!p.telephoneComptoir) {
      missing.push("tel_comptoir");
    }
  }

  // =========================
  // 🟢 MODE APPLICATEUR
  // =========================
  if (p.projectModele === "applicateur") {
    if (!p.dallagiste) {
      missing.push("dallagiste");
    }
    if (!p.telephoneDallagiste) {
      missing.push("tel_dallagiste");
    }
  }

  // =========================
  // 🔴 COMMUN (TOUS LES MODES)
  // =========================
  if (!p.entreprise) {
    missing.push("entreprise");
  }

  if (!p.bureauControle) {
    missing.push("bureau");
  }

  return missing;
}

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

      const missingFields = getMissingFields(p);
      const isIncomplete = missingFields.length > 0;

      if (isIncomplete && diffDays >= 7) {
        p.isArchived = true;
        p.archivedAt = now;

        await p.save();

        console.log(
          "📦 ARCHIVED:",
          p.nomProjet,
          "| Days:",
          diffDays,
          "| Missing:",
          missingFields
        );
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

      const missingFields = getMissingFields(p);

      const createdAt = new Date(p.createdAt);
      const diffDays = Math.floor((now - createdAt) / DAY_MS);

      // =========================
      // 🚫 PAS DE SPAM
      // =========================
      const last = p.lastRelanceAt ? new Date(p.lastRelanceAt) : null;

      const alreadyToday =
        last && last.toDateString() === now.toDateString();

      // =========================
      // 📧 RELANCE INTELLIGENTE
      // =========================
      if (missingFields.length > 0 && !alreadyToday && diffDays < 7) {

        console.log(
          `📧 RELANCE ${p.projectModele?.toUpperCase()} | ${p.nomProjet} | Missing:`,
          missingFields
        );

        // 🔵 PROJECT
        if (missingFields.includes("ingenieur")) {
          await sendRelanceIngenieurEmail(email, p);
        }

        // 🟡 REVENDEUR
        if (
          missingFields.includes("comptoir") ||
          missingFields.includes("tel_comptoir")
        ) {
          await sendRelanceEntrepriseEmail(email, p);
        }

        // 🟢 APPLICATEUR
        if (
          missingFields.includes("dallagiste") ||
          missingFields.includes("tel_dallagiste")
        ) {
          await sendRelanceEntrepriseEmail(email, p);
        }

        // 🔴 ENTREPRISE
        if (missingFields.includes("entreprise")) {
          await sendRelanceEntrepriseEmail(email, p);
        }

        // 🟠 BUREAU CONTROLE
        if (missingFields.includes("bureau")) {
          await sendRelanceBureauControleEmail(email, p);
        }

        // 🔥 SAVE LAST RELANCE
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