const cron = require("node-cron");

const { Project, User, UserProject } = require("../models");
const Notification = require("../models/Notification");
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
      const userId = owner?.User?.id;

      if (!email || !userId) continue;

      const missingFields = getMissingFields(p);

      const createdAt = new Date(p.createdAt);
      const diffDays = Math.floor((now - createdAt) / DAY_MS);

      const last = p.lastRelanceAt ? new Date(p.lastRelanceAt) : null;

      const alreadyToday =
        last && last.toDateString() === now.toDateString();

      // =========================
      // 📧 RELANCE
      // =========================
      if (missingFields.length > 0 && !alreadyToday && diffDays < 7) {

        console.log(
          `📧 RELANCE ${p.projectModele?.toUpperCase()} | ${p.nomProjet}`
        );

        let type = "PROJECT_RELANCE";
        let message = `Relance pour projet ${p.nomProjet}`;

        try {

          // 🔵 PROJECT
          if (missingFields.includes("ingenieur")) {
            await sendRelanceIngenieurEmail(email, p);
            message = `Projet ${p.nomProjet} sans ingénieur`;
          }

          // 🟡 REVENDEUR
          if (
            missingFields.includes("comptoir") ||
            missingFields.includes("tel_comptoir")
          ) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Informations comptoir manquantes (${p.nomProjet})`;
          }

          // 🟢 APPLICATEUR
          if (
            missingFields.includes("dallagiste") ||
            missingFields.includes("tel_dallagiste")
          ) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Informations dallagiste manquantes (${p.nomProjet})`;
          }

          // 🔴 ENTREPRISE
          if (missingFields.includes("entreprise")) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Entreprise manquante (${p.nomProjet})`;
          }

          // 🟠 BUREAU
          if (missingFields.includes("bureau")) {
            await sendRelanceBureauControleEmail(email, p);
            message = `Bureau de contrôle manquant (${p.nomProjet})`;
          }

          // =========================
          // 🔔 NOTIFICATION
          // =========================
          await Notification.create({
            userId: userId,
            type: "PROJECT_RELANCE",
            title: "Relance projet",
            message: message,
            projectId: p.id,
            isRead: false,
          });

          // =========================
          // 💾 SAVE
          // =========================
          p.lastRelanceAt = now;
          await p.save();

        } catch (err) {
          console.error("❌ EMAIL ERROR:", err.message);

          await Notification.create({
            userId: userId,
            type: "PROJECT_ERROR",
            title: "Erreur relance",
            message: `Erreur envoi pour ${p.nomProjet}`,
            projectId: p.id,
            isRead: false,
          });
        }
      }
    }

    await archiveProjects(projects);

    console.log("✅ CRON END");

  } catch (e) {
    console.error("❌ CRON ERROR:", e.message);
  }
}async function checkProjects() {
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
      const userId = owner?.User?.id;

      if (!email || !userId) continue;

      const missingFields = getMissingFields(p);

      const createdAt = new Date(p.createdAt);
      const diffDays = Math.floor((now - createdAt) / DAY_MS);

      const last = p.lastRelanceAt ? new Date(p.lastRelanceAt) : null;

      const alreadyToday =
        last && last.toDateString() === now.toDateString();

      // =========================
      // 📧 RELANCE
      // =========================
      if (missingFields.length > 0 && !alreadyToday && diffDays < 7) {

        console.log(
          `📧 RELANCE ${p.projectModele?.toUpperCase()} | ${p.nomProjet}`
        );

        let type = "PROJECT_RELANCE";
        let message = `Relance pour projet ${p.nomProjet}`;

        try {

          // 🔵 PROJECT
          if (missingFields.includes("ingenieur")) {
            await sendRelanceIngenieurEmail(email, p);
            message = `Projet ${p.nomProjet} sans ingénieur`;
          }

          // 🟡 REVENDEUR
          if (
            missingFields.includes("comptoir") ||
            missingFields.includes("tel_comptoir")
          ) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Informations comptoir manquantes (${p.nomProjet})`;
          }

          // 🟢 APPLICATEUR
          if (
            missingFields.includes("dallagiste") ||
            missingFields.includes("tel_dallagiste")
          ) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Informations dallagiste manquantes (${p.nomProjet})`;
          }

          // 🔴 ENTREPRISE
          if (missingFields.includes("entreprise")) {
            await sendRelanceEntrepriseEmail(email, p);
            message = `Entreprise manquante (${p.nomProjet})`;
          }

          // 🟠 BUREAU
          if (missingFields.includes("bureau")) {
            await sendRelanceBureauControleEmail(email, p);
            message = `Bureau de contrôle manquant (${p.nomProjet})`;
          }

          // =========================
          // 🔔 NOTIFICATION
          // =========================
          await Notification.create({
            userId: userId,
            type: "PROJECT_RELANCE",
            title: "Relance projet",
            message: message,
            projectId: p.id,
            isRead: false,
          });

          // =========================
          // 💾 SAVE
          // =========================
          p.lastRelanceAt = now;
          await p.save();

        } catch (err) {
          console.error("❌ EMAIL ERROR:", err.message);

          await Notification.create({
            userId: userId,
            type: "PROJECT_ERROR",
            title: "Erreur relance",
            message: `Erreur envoi pour ${p.nomProjet}`,
            projectId: p.id,
            isRead: false,
          });
        }
      }
    }

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