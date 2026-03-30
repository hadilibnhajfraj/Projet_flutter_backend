const cron = require("node-cron");
const { Op } = require("sequelize");
const Project = require("../models/Project");
const sendEmail = require("../utils/sendEmail");

// 🔥 Toutes les heures
cron.schedule("0 * * * *", async () => {
  console.log("⏳ Vérification des projets...");

  const now = new Date();

  const projects = await Project.findAll({
    where: {
      isArchived: false,
      ingenieurResponsable: null,
      dateLimiteIngenieur: {
        [Op.lte]: now,
      },
    },
  });

  for (const p of projects) {

    // 📧 envoyer email
    await sendEmail({
      to: "user@email.com", // 🔥 récupère depuis user
      subject: "⚠️ Relance projet",
      text: `Le projet ${p.nomProjet} n'a pas d'ingénieur après 7 jours.`,
    });

    // 📦 ARCHIVER
    await p.update({
      isArchived: true,
      archivedAt: new Date(),
    });

    console.log(`📦 Projet archivé: ${p.nomProjet}`);
  }
});