const { ProjectAction, ProjectReminder } = require("../models/associations");


// ==============================
// CREATE ACTION
// ==============================
exports.createAction = async (req, res) => {
  try {

    const {
      projectId,
      typeAction,
      commentaire,
      dateAction,
      dateRelance
    } = req.body;

    const createdBy = req.user?.id || req.body.createdBy;

    // création action
    const action = await ProjectAction.create({
      projectId,
      typeAction,
      commentaire,
      dateAction,
      createdBy
    });

    // création reminder si relance
    if (dateRelance) {

      await ProjectReminder.create({
        projectId,
        actionId: action.id,
        message: "Relance prévue",
        dateRelance,
        createdBy
      });

    }

    // renvoyer avec reminders
    const actionWithReminder = await ProjectAction.findByPk(action.id, {
      include: [
        {
          model: ProjectReminder,
          as: "reminders"
        }
      ]
    });

    res.status(201).json(actionWithReminder);

  } catch (error) {

    console.error(error);
    res.status(500).json({ message: "Erreur création action" });

  }
};


// ==============================
// GET PROJECT ACTIONS
// ==============================
exports.getProjectActions = async (req, res) => {

  try {

    const { projectId } = req.params;

    const actions = await ProjectAction.findAll({

      where: { projectId },

      include: [
        {
          model: ProjectReminder,
          as: "reminders"
        }
      ],

      order: [["dateAction", "DESC"]]

    });

    res.json(actions);

  } catch (error) {

    console.error(error);
    res.status(500).json({ error: error.message });

  }

};


// ==============================
// GET TIMELINE CRM
// ==============================
exports.getTimeline = async (req, res) => {

  try {

    const { projectId } = req.params;

    const timeline = await ProjectAction.findAll({

      where: { projectId },

      include: [
        {
          model: ProjectReminder,
          as: "reminders"
        }
      ],

      order: [["dateAction", "ASC"]]

    });

    res.json(timeline);

  } catch (error) {

    console.error(error);
    res.status(500).json({ error: error.message });

  }

};