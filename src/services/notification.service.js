const { Notification, Project, ProjectMember, User } = require("../models");

async function notifyProjectComment({ projectId, commentId, authorId, body }) {
  // 1) récupérer projet + owner
  const project = await Project.findByPk(projectId);
  if (!project) return;

  // 2) Destinataires = owner + members (sans auteur)
  const recipients = new Set();

  if (project.ownerId) recipients.add(project.ownerId);

  // si tu as ProjectMember
  const members = await ProjectMember.findAll({
    where: { projectId },
    attributes: ["userId"],
  });

  for (const m of members) recipients.add(m.userId);

  recipients.delete(authorId);

  if (recipients.size === 0) return;

  // 3) récupérer auteur (pour afficher son nom/email)
  const author = await User.findByPk(authorId);
  const authorLabel = author?.email ?? "Quelqu’un";

  const title = "Nouveau commentaire";
  const message = `${authorLabel} a commenté sur le projet`;

  const payload = Array.from(recipients).map((userId) => ({
    userId,
    type: "PROJECT_COMMENT",
    title,
    message,
    projectId,
    commentId,
    isRead: false,
  }));

  await Notification.bulkCreate(payload);
}

module.exports = { notifyProjectComment };
