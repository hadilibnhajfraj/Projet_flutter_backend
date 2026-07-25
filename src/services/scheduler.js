const cron = require("node-cron");

const Project = require("../models/Project");
const ProjectAction = require("../models/ProjectAction");
const User = require("../models/User");
const projectActionService = require("../modules/project-actions/services/projectAction.service");

console.log("🚀 CRM Scheduler started");

// ─── Kill switch for all automatic email cron jobs ────────────────────────────
// Default: DISABLED. Set AUTO_EMAIL_JOBS_ENABLED=true in .env to re-enable.
const AUTO_EMAIL_JOBS_ENABLED = process.env.AUTO_EMAIL_JOBS_ENABLED === "true";

if (!AUTO_EMAIL_JOBS_ENABLED) {
  console.log("[scheduler] AUTO_EMAIL_JOBS_ENABLED=false — relance cron NOT scheduled.");
} else {
cron.schedule("* * * * *", async () => {

  console.log("⏱ Checking projects for relance...");

  try {

    const superAdmin = await User.findOne({
      where: { email: process.env.SUPERADMIN_EMAIL }
    });

    if (!superAdmin) {
      console.warn("[scheduler] SUPERADMIN_EMAIL introuvable — relance automatique désactivée pour ce tick.");
      return;
    }

    const projects = await Project.findAll();

    console.log("📁 Projects found:", projects.length);

    for (const p of projects) {

      const lastAction = await ProjectAction.findOne({
        where: { projectId: p.id },
        order: [["dateAction", "DESC"]],
      });

      if (!lastAction) continue;

      // BUG FIX : le champ réel du modèle est `typeAction_legacy`, pas
      // `typeAction` — l'ancienne condition comparait toujours `undefined`
      // à "Relance" (donc ne sautait jamais une relance déjà créée).
      if (lastAction.typeAction_legacy === "Relance") continue;

      const diff = Date.now() - new Date(lastAction.dateAction).getTime();
      const hours = diff / (1000 * 60 * 60);

      if (hours > 48) {

        // Responsable = Project.ownerId (source unique de vérité utilisée
        // partout ailleurs — Task/Google Calendar/email ciblent ce champ,
        // voir projectActionCalendarSync.service.js). Pas de relance
        // automatique possible sans propriétaire connu.
        if (!p.ownerId) {
          console.warn(`[scheduler] SKIP projet=${p.id} (${p.nomProjet}) : aucun ownerId — relance automatique impossible.`);
          continue;
        }

        const owner = await User.findByPk(p.ownerId);
        if (!owner?.email) {
          console.warn(`[scheduler] SKIP projet=${p.id} (${p.nomProjet}) : propriétaire sans email.`);
          continue;
        }

        console.log("🔔 Creating automatic relance...");
        console.log("Commercial   :", owner.email);
        console.log("Owner Email  :", owner.email);

        // Passe par le service standard (createAction) plutôt que par un
        // ProjectAction.create() direct : c'est ce qui déclenche
        // automatiquement le calendrier CRM (Task), Google Calendar et
        // l'email au propriétaire (voir projectActionCalendarSync.service.js
        // ::onActionCreated, appelé en interne par createAction()). Le
        // scheduler ne doit plus dupliquer cette logique lui-même.
        const created = await projectActionService.createAction(
          p.id,
          {
            typeAction: "Relance",
            commentaire: "Relance automatique CRM (aucune activité depuis plus de 48h)",
          },
          superAdmin.id
        );

        console.log("✅ Follow-up créé :", created.id, "| Projet :", p.nomProjet);

      }

    }

  } catch (err) {

    console.error("❌ Scheduler error:", err);

  }

});
}
