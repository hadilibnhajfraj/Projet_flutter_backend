const { ProjectAction, ProjectReminder, Project } = require("../models/associations");

exports.getTimeline = async (req, res) => {
  try {

    const projectId = req.params.projectId;

    const actions = await ProjectAction.findAll({
      where: { projectId },
      include: [
        {
          model: ProjectReminder,
          as: "reminders"
        }
      ],
      order: [["dateAction", "DESC"]],
    });

    res.json(actions);

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur timeline" });
  }
};