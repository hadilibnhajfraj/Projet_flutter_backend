"use strict";

const ArchiveRequest = require("../../../models/ArchiveRequest");
const ArchiveRequestMessage = require("../../../models/ArchiveRequestMessage");
const Notification = require("../../../models/Notification");
const Project = require("../../../models/Project");
const ProjectActivity = require("../../../models/ProjectActivity");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
const { emitToUser, emitToRoom } = require("../../../socket");
const { sendEmail } = require("../../../services/email.service");
const { sendWhatsappMessage } = require("../../../services/whatsapp.service");
const { ROOT_ADMIN_EMAIL } = require("../../../config/rootAdmin");

const TYPE_LABEL = {
  ARCHIVAGE: "archivage",
  DESARCHIVAGE: "désarchivage",
};

const CRM_LINK = process.env.APP_URL || "http://localhost:3000";

// ── Helpers ───────────────────────────────────────────────

const USER_INCLUDE = {
  model: User,
  as: "user",
  attributes: ["id", "email"],
  include: [{ model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false }],
  required: false,
};

function _userShape(u) {
  if (!u) return null;
  const profile = u.profile || {};
  return { id: u.id, email: u.email, name: profile.name || u.email };
}

async function _getRootAdmin() {
  return User.findOne({
    where: { email: ROOT_ADMIN_EMAIL },
    attributes: ["id", "email"],
  });
}

// ── HTML email template (partagé création / approbation / refus) ──────────

function _buildEmail({ heading, emoji, intro, projectName, userName, userEmail, subject, message, requestId, createdAt, footerNote }) {
  const date = new Date(createdAt).toLocaleDateString("fr-FR", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:36px 40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">
              ${emoji} ${heading}
            </h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">CRM PROBAR</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px;">

            <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
              ${intro}
            </p>

            <!-- Info card -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
              <tr>
                <td style="padding:24px;">
                  <table width="100%" cellpadding="0" cellspacing="8">
                    <tr>
                      <td width="130" style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">📁 Projet</td>
                      <td style="color:#111827;font-size:14px;font-weight:600;padding:6px 0;">${projectName}</td>
                    </tr>
                    <tr>
                      <td style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">👤 Utilisateur</td>
                      <td style="color:#111827;font-size:14px;padding:6px 0;">${userName} &lt;${userEmail}&gt;</td>
                    </tr>
                    <tr>
                      <td style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">📅 Date</td>
                      <td style="color:#111827;font-size:14px;padding:6px 0;">${date}</td>
                    </tr>
                    <tr>
                      <td style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">📌 Sujet</td>
                      <td style="color:#111827;font-size:14px;font-weight:600;padding:6px 0;">${subject}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Message -->
            <p style="margin:0 0 8px;color:#374151;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Motif</p>
            <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:32px;">
              <p style="margin:0;color:#1e40af;font-size:14px;line-height:1.7;">${message}</p>
            </div>

            <!-- Footer note -->
            <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;border-top:1px solid #f3f4f6;padding-top:20px;">
              ${footerNote}<br/>
              <a href="${CRM_LINK}" style="color:#667eea;">Ouvrir le CRM</a> ·
              ID demande : <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${requestId}</code>
            </p>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #f3f4f6;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">© ${new Date().getFullYear()} CRM PROBAR — Tous droits réservés</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Shared include fragments ──────────────────────────────

const REQUESTER_INCLUDE = {
  model: User,
  as: "requester",
  attributes: ["id", "email"],
  include: [{ model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false }],
  required: false,
};

const PROJECT_INCLUDE = {
  model: Project,
  as: "archiveProject",
  attributes: ["id", "nomProjet", "isArchived", "archiveReason"],
  required: false,
};

// ── Service functions ─────────────────────────────────────

async function createRequest(userId, { projectId, subject, message, type }) {
  const requestType = type === "ARCHIVAGE" ? "ARCHIVAGE" : "DESARCHIVAGE";
  const label = TYPE_LABEL[requestType];
  const article = requestType === "ARCHIVAGE" ? "d'" : "de ";

  const project = await Project.findByPk(projectId, { attributes: ["id", "nomProjet", "isArchived", "ownerId"] });
  if (!project) throw { status: 404, message: "Projet introuvable" };

  // Seul le propriétaire du projet peut demander son archivage/désarchivage.
  // Ne jamais faire confiance uniquement au frontend — revalidé ici même si
  // le bouton est déjà masqué côté Flutter pour les non-propriétaires.
  if (project.ownerId !== userId) {
    throw { status: 403, message: "Vous n'êtes pas autorisé à archiver ce projet." };
  }

  if (requestType === "DESARCHIVAGE" && !project.isArchived) {
    throw { status: 400, message: "Ce projet n'est pas archivé" };
  }
  if (requestType === "ARCHIVAGE" && project.isArchived) {
    throw { status: 400, message: "Ce projet est déjà archivé" };
  }

  const existing = await ArchiveRequest.findOne({
    where: { projectId, userId, type: requestType, status: "pending" },
  });
  if (existing) {
    const err = new Error(`Une demande ${article}${label} est déjà en attente de validation.`);
    err.status = 409;
    err.requestId = existing.id;
    throw err;
  }

  const admin = await _getRootAdmin();
  if (!admin) throw { status: 400, message: "Aucun administrateur trouvé — demande impossible" };

  const requester = await User.findByPk(userId, {
    attributes: ["id", "email"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
  });

  const request = await ArchiveRequest.create({
    projectId,
    userId,
    adminId: admin.id,
    type: requestType,
    subject,
    message,
    status: "pending",
  });

  const userName = requester?.profile?.name || requester?.email || "Utilisateur";
  const userEmail = requester?.email || "";

  // Historique projet — "Demande d'archivage créée." / "Demande de désarchivage créée."
  await ProjectActivity.create({
    projectId,
    userId,
    type: requestType === "ARCHIVAGE" ? "archive_request_created" : "unarchive_request_created",
    message: `Demande ${requestType === "ARCHIVAGE" ? "d'" : "de "}${label} créée.`,
    metadata: { requestId: request.id },
  });

  // Notification interne pour l'admin (temps réel + centre de notifications)
  await Notification.create({
    userId: admin.id,
    type: requestType === "ARCHIVAGE" ? "ARCHIVE_REQUEST_CREATED" : "UNARCHIVE_REQUEST_CREATED",
    title: `Nouvelle demande ${article}${label}`,
    message: `${userName} a demandé le ${label} du projet "${project.nomProjet}"`,
    projectId,
    isRead: false,
  });

  // Socket temps réel
  const eventPayload = {
    requestId: request.id,
    projectId,
    projectName: project.nomProjet,
    userId,
    type: requestType,
    subject,
    createdAt: request.createdAt,
  };
  emitToUser(admin.id, "archive-request-created", eventPayload);
  emitToRoom("admins", "archive-request-created", eventPayload);

  // Email (fire-and-forget)
  const html = _buildEmail({
    heading: `Demande ${article}${label}`,
    emoji: requestType === "ARCHIVAGE" ? "📦" : "📬",
    intro: `Un utilisateur souhaite ${label === "archivage" ? "archiver" : "désarchiver"} un projet. Veuillez examiner la demande ci-dessous.`,
    projectName: project.nomProjet,
    userName,
    userEmail,
    subject,
    message,
    requestId: request.id,
    createdAt: request.createdAt,
    footerNote: "Connectez-vous au CRM pour approuver ou rejeter cette demande.",
  });
  sendEmail(admin.email, `Nouvelle demande ${article}${label}`, message, { requestId: request.id }, { html }).catch(() => null);

  // WhatsApp (best-effort, jamais bloquant)
  if (process.env.CBI_ADMIN_WHATSAPP_NUMBER) {
    const waMessage = `Nouvelle demande ${article}${label}\n\nProjet :\n${project.nomProjet}\n\nUtilisateur :\n${userName}\n\nEmail :\n${userEmail}\n\nMotif :\n${message}`;
    sendWhatsappMessage(process.env.CBI_ADMIN_WHATSAPP_NUMBER, waMessage).catch(() => null);
  }

  return request;
}

async function approveRequest(adminId, requestId) {
  const request = await ArchiveRequest.findByPk(requestId, { include: [PROJECT_INCLUDE, REQUESTER_INCLUDE] });
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.status !== "pending") throw { status: 400, message: "Cette demande a déjà été traitée" };

  const approvedAt = new Date();
  await request.update({ status: "approved", adminId, approvedBy: adminId, approvedAt });

  if (request.type === "ARCHIVAGE") {
    await Project.update(
      { isArchived: true, archivedAt: approvedAt, archiveReason: request.message },
      { where: { id: request.projectId } }
    );
  } else {
    await Project.update(
      { isArchived: false, archivedAt: null, archiveReason: null },
      { where: { id: request.projectId } }
    );
  }

  const label = TYPE_LABEL[request.type];
  const article = request.type === "ARCHIVAGE" ? "d'" : "de ";
  const project = request.archiveProject;
  const requester = request.requester;
  const requesterName = requester?.profile?.name || requester?.email || "Utilisateur";
  const projectName = project?.nomProjet || "Projet";

  // Historique projet — "Demande approuvée." + "Projet archivé/désarchivé."
  await ProjectActivity.create({
    projectId: request.projectId,
    userId: adminId,
    type: "archive_request_approved",
    message: "Demande approuvée.",
    metadata: { requestId: request.id, approvedBy: adminId, approvedAt },
  });
  await ProjectActivity.create({
    projectId: request.projectId,
    userId: adminId,
    type: request.type === "ARCHIVAGE" ? "project_archived" : "project_unarchived",
    message: request.type === "ARCHIVAGE" ? "Projet archivé." : "Projet désarchivé.",
    metadata: { requestId: request.id, approvedBy: adminId, approvedAt },
  });

  await Notification.create({
    userId: request.userId,
    type: request.type === "ARCHIVAGE" ? "ARCHIVE_REQUEST_APPROVED" : "UNARCHIVE_REQUEST_APPROVED",
    title: `${request.type === "ARCHIVAGE" ? "Archivage" : "Désarchivage"} approuvé`,
    message: `Votre demande ${article}${label} a été approuvée`,
    projectId: request.projectId,
    isRead: false,
  });

  emitToUser(request.userId, "archive-request-approved", {
    requestId,
    projectId: request.projectId,
    type: request.type,
    message: `Votre demande ${article}${label} a été approuvée`,
  });

  if (requester?.email) {
    const dateStr = approvedAt.toLocaleDateString("fr-FR", {
      year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const text = `Bonjour ${requesterName},\n\n` +
      `Votre demande ${request.type === "ARCHIVAGE" ? "d'archivage" : "de désarchivage"} concernant le projet :\n\n` +
      `${projectName}\n\n` +
      `a été approuvée par l'administrateur.\n\n` +
      `Le projet est maintenant ${request.type === "ARCHIVAGE" ? "archivé" : "désarchivé"}.\n\n` +
      `Date :\n${dateStr}\n\n` +
      `Merci.`;

    const html = _buildEmail({
      heading: `Demande ${article}${label} approuvée`,
      emoji: "✅",
      intro: `Votre demande ${article}${label} concernant le projet <strong>${projectName}</strong> a été approuvée par l'administrateur. Le projet est maintenant ${request.type === "ARCHIVAGE" ? "archivé" : "désarchivé"}.`,
      projectName,
      userName: requesterName,
      userEmail: requester.email,
      subject: request.subject,
      message: request.message,
      requestId: request.id,
      createdAt: approvedAt,
      footerNote: "Ceci est une confirmation automatique du CRM.",
    });
    sendEmail(requester.email, `Votre demande ${article}${label} a été approuvée`, text, { requestId }, { html }).catch(() => null);
  }

  // WhatsApp au demandeur : aucun numéro n'est stocké sur User/UserProfile
  // aujourd'hui — non envoyé (voir plan, section "numéro WhatsApp du demandeur").

  return request;
}

async function rejectRequest(adminId, requestId, reason) {
  const request = await ArchiveRequest.findByPk(requestId, { include: [PROJECT_INCLUDE, REQUESTER_INCLUDE] });
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.status !== "pending") throw { status: 400, message: "Cette demande a déjà été traitée" };

  const rejectedAt = new Date();
  const rejectionReason = reason || `Votre demande de ${TYPE_LABEL[request.type]} a été refusée`;

  await request.update({ status: "rejected", adminId, rejectionReason, rejectedBy: adminId, rejectedAt });

  const label = TYPE_LABEL[request.type];
  const article = request.type === "ARCHIVAGE" ? "d'" : "de ";
  const project = request.archiveProject;
  const requester = request.requester;
  const requesterName = requester?.profile?.name || requester?.email || "Utilisateur";
  const projectName = project?.nomProjet || "Projet";

  // Historique projet — "Demande refusée."
  await ProjectActivity.create({
    projectId: request.projectId,
    userId: adminId,
    type: "archive_request_rejected",
    message: "Demande refusée.",
    metadata: { requestId: request.id, rejectedBy: adminId, rejectedAt, reason: reason || null },
  });

  await Notification.create({
    userId: request.userId,
    type: request.type === "ARCHIVAGE" ? "ARCHIVE_REQUEST_REJECTED" : "UNARCHIVE_REQUEST_REJECTED",
    title: `${request.type === "ARCHIVAGE" ? "Archivage" : "Désarchivage"} refusé`,
    message: rejectionReason,
    projectId: request.projectId,
    isRead: false,
  });

  emitToUser(request.userId, "archive-request-rejected", {
    requestId,
    projectId: request.projectId,
    type: request.type,
    message: rejectionReason,
  });

  if (requester?.email) {
    const dateStr = rejectedAt.toLocaleDateString("fr-FR", {
      year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const text = `Bonjour ${requesterName},\n\n` +
      `Votre demande ${article}${label} concernant le projet :\n\n` +
      `${projectName}\n\n` +
      `a été refusée par l'administrateur.\n\n` +
      (reason ? `Commentaire de l'administrateur :\n${reason}\n\n` : "") +
      `Date :\n${dateStr}\n\n` +
      `Merci.`;

    const html = _buildEmail({
      heading: `Demande ${article}${label} refusée`,
      emoji: "❌",
      intro: `Votre demande ${article}${label} concernant le projet <strong>${projectName}</strong> a été refusée par l'administrateur.`,
      projectName,
      userName: requesterName,
      userEmail: requester.email,
      subject: request.subject,
      message: reason || rejectionReason,
      requestId: request.id,
      createdAt: rejectedAt,
      footerNote: "Ceci est une confirmation automatique du CRM.",
    });
    sendEmail(requester.email, `Votre demande ${article}${label} a été refusée`, text, { requestId }, { html }).catch(() => null);
  }

  return request;
}

async function deleteRequest(requestId) {
  const request = await ArchiveRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };
  await request.destroy();
  return { id: requestId };
}

async function getStats() {
  const [pending, archivage, desarchivage, approved, rejected] = await Promise.all([
    ArchiveRequest.count({ where: { status: "pending" } }),
    ArchiveRequest.count({ where: { type: "ARCHIVAGE" } }),
    ArchiveRequest.count({ where: { type: "DESARCHIVAGE" } }),
    ArchiveRequest.count({ where: { status: "approved" } }),
    ArchiveRequest.count({ where: { status: "rejected" } }),
  ]);
  return { pending, archivage, desarchivage, approved, rejected };
}

async function getPendingCount() {
  return ArchiveRequest.count({ where: { status: "pending" } });
}

async function addMessage(senderId, requestId, messageText) {
  const request = await ArchiveRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.status === "rejected") throw { status: 400, message: "Cette demande est clôturée" };

  const sender = await User.findByPk(senderId, {
    attributes: ["id", "email"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false }],
  });

  const msg = await ArchiveRequestMessage.create({ requestId, senderId, message: messageText });

  const payload = {
    id: msg.id,
    requestId,
    message: messageText,
    createdAt: msg.createdAt,
    sender: _userShape(sender),
  };

  if (senderId !== request.userId) emitToUser(request.userId, "archive-request-message", payload);
  if (request.adminId && senderId !== request.adminId) emitToUser(request.adminId, "archive-request-message", payload);
  emitToRoom("admins", "archive-request-message", payload);

  return payload;
}

async function getMyRequests(userId) {
  return ArchiveRequest.findAll({
    where: { userId },
    include: [PROJECT_INCLUDE],
    order: [["createdAt", "DESC"]],
  });
}

// adminUserId = the logged-in admin's ID — only returns requests assigned to them
async function getAdminRequests(adminUserId, status) {
  const where = { adminId: adminUserId };
  if (status) where.status = status;

  return ArchiveRequest.findAll({
    where,
    include: [REQUESTER_INCLUDE, PROJECT_INCLUDE],
    order: [["createdAt", "DESC"]],
  });
}

async function getMessages(requestId, userId, userEmail) {
  const request = await ArchiveRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };

  const isRootAdmin = (userEmail || "").toLowerCase().trim() === ROOT_ADMIN_EMAIL;
  if (!isRootAdmin && request.userId !== userId) throw { status: 403, message: "Accès refusé" };

  const messages = await ArchiveRequestMessage.findAll({
    where: { requestId },
    include: [
      {
        model: User,
        as: "sender",
        attributes: ["id", "email"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false }],
        required: false,
      },
    ],
    order: [["createdAt", "ASC"]],
  });

  return messages.map((m) => {
    const j = m.toJSON();
    return { ...j, sender: _userShape(j.sender) };
  });
}

module.exports = {
  createRequest,
  approveRequest,
  rejectRequest,
  deleteRequest,
  getStats,
  getPendingCount,
  addMessage,
  getMyRequests,
  getAdminRequests,
  getMessages,
};
