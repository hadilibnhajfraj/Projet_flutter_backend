const cron = require("node-cron");
const ProjectAction = require("../models/ProjectAction");
const { Op } = require("sequelize");

cron.schedule("0 8 * * *", async () => {

  const today = new Date();

  const actions = await ProjectAction.findAll({
    where: {
      dateRelance: {
        [Op.lte]: today,
      },
      statut: "A faire",
    },
  });

  actions.forEach(action => {

    console.log(
      "Relance CRM :",
      action.typeAction,
      action.projectId
    );

  });

});