const cron = require("node-cron");
const { ProjectAction, Project } = require("../models");

cron.schedule("0 * * * *", async () => {

  const projects = await Project.findAll();

  for (const p of projects) {

    const lastAction = await ProjectAction.findOne({
      where: { projectId: p.id },
      order: [["dateAction", "DESC"]],
    });

    if (!lastAction) continue;

    const diff = Date.now() - new Date(lastAction.dateAction).getTime();

    const hours = diff / (1000 * 60 * 60);

    if (hours > 48) {

      await ProjectAction.create({

        projectId: p.id,
        typeAction: "Relance",
        commentaire: "Relance automatique >48h",
        createdBy: "system",
        dateAction: new Date()

      });

    }
  }

});