const cron = require("node-cron");
const { Op } = require("sequelize");

const ProjectAction = require("../models/ProjectAction");
const Project = require("../models/Project");
const User = require("../models/User");

const { sendRelanceEmail } = require("../utils/sendRelanceEmail");

cron.schedule("0 8 * * *", async () => {

  console.log("⏰ CRON RELANCE START");

  const now = new Date();

  /// 🔥 DATE -2 JOURS
  const in2Days = new Date();
  in2Days.setDate(now.getDate() + 2);

  try {

    /// =========================
    /// ✅ CAS 1 : AVANT RELANCE
    /// =========================
    const upcomingActions = await ProjectAction.findAll({
      where: {
        dateRelance: {
          [Op.between]: [now, in2Days],
        },
        statut: "A faire",
      },
      include: [Project],
    });

    for (const action of upcomingActions) {

      const project = action.Project;

      if (!project) continue;

      const user = await User.findByPk(project.createdBy);

      if (!user?.email) continue;

      console.log("📧 Relance AVANT échéance :", project.nomProjet);

      await sendRelanceEmail(user.email, project.nomProjet);
    }

    /// =========================
    /// ✅ CAS 2 : PAS DE DATE
    /// =========================
    const noDateActions = await ProjectAction.findAll({
      where: {
        dateRelance: null,
        statut: "A faire",
      },
      include: [Project],
    });

    for (const action of noDateActions) {

      const lastUpdate = new Date(action.updatedAt || action.createdAt);

      const diffHours = (now - lastUpdate) / (1000 * 60 * 60);

      /// 🔥 CHAQUE 48H
      if (diffHours >= 48) {

        const project = action.Project;

        if (!project) continue;

        const user = await User.findByPk(project.createdBy);

        if (!user?.email) continue;

        console.log("📧 Relance automatique (48h) :", project.nomProjet);

        await sendRelanceEmail(user.email, project.nomProjet);
      }
    }

    console.log("✅ CRON RELANCE DONE");

  } catch (e) {
    console.error("❌ CRON ERROR:", e);
  }

});