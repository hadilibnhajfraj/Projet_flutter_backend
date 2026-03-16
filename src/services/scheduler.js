const cron = require("node-cron");

const Project = require("../models/Project");
const ProjectAction = require("../models/ProjectAction");
const UserProject = require("../models/UserProject");
const User = require("../models/User");

const { sendRelanceEmail } = require("./emailService");

console.log("🚀 CRM Scheduler started");

cron.schedule("* * * * *", async () => {

  console.log("⏱ Checking projects for relance...");

  try {

    const superAdmin = await User.findOne({
      where: { email: process.env.SUPERADMIN_EMAIL }
    });

    const projects = await Project.findAll();

    console.log("📁 Projects found:", projects.length);

    for (const p of projects) {

      console.log("🔎 Checking project:", p.id);

      const lastAction = await ProjectAction.findOne({
        where: { projectId: p.id },
        order: [["dateAction", "DESC"]],
      });

      if (!lastAction) continue;

      if(lastAction.typeAction === "Relance") continue;

      const diff = Date.now() - new Date(lastAction.dateAction).getTime();
      const hours = diff / (1000 * 60 * 60);

      if (hours > 48) {

        console.log("🔔 Creating automatic relance...");

        const action = await ProjectAction.create({

          projectId: p.id,
          typeAction: "Relance",
          commentaire: "Relance automatique CRM",
          createdBy: superAdmin ? superAdmin.id : null,
          dateAction: new Date(),
          statut: "A faire"

        });

        console.log("✅ Relance created:", action.id);

        const link = await UserProject.findOne({
          where: { projectId: p.id, permission: "owner" }
        });

        if (!link) continue;

        const user = await User.findByPk(link.userId);

        if (user && user.email) {

          console.log("📧 Sending email to:", user.email);

          await sendRelanceEmail(user.email, p.nomProjet);

        }

      }

    }

  } catch (err) {

    console.error("❌ Scheduler error:", err);

  }

});