"use strict";

const nodemailer = require("nodemailer");
const ArchiveRequest = require("../../../models/ArchiveRequest");
const ArchiveRequestMessage = require("../../../models/ArchiveRequestMessage");
const Notification = require("../../../models/Notification");
const Project = require("../../../models/Project");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
const { emitToUser, emitToRoom } = require("../../../socket");

const _transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || "587"),
  secure: process.env.EMAIL_SECURE === "true",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  tls: { rejectUnauthorized: false },
});

async function _sendHtml(to, subject, html) {
  try {
    await _transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
  } catch (e) {
    console.error("[ARCHIVE_EMAIL_ERROR]", e.message);
  }
}

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

async function _getAdmins() {
  return User.findAll({
    where: { role: ["admin", "superadmin"] },
    attributes: ["id", "email"],
  });
}

// ── HTML email template ───────────────────────────────────

function _buildAdminEmail({ projectName, userName, userEmail, subject, message, requestId, createdAt }) {
  const date = new Date(createdAt).toLocaleDateString("fr-FR", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Demande de désarchivage</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:36px 40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">
              📬 Demande de désarchivage
            </h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">CRM PROBAR — Nouvelle demande</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px;">

            <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
              Un utilisateur souhaite désarchiver un projet. Veuillez examiner la demande ci-dessous.
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
            <p style="margin:0 0 8px;color:#374151;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Message</p>
            <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:32px;">
              <p style="margin:0;color:#1e40af;font-size:14px;line-height:1.7;">${message}</p>
            </div>

            <!-- Footer note -->
            <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;border-top:1px solid #f3f4f6;padding-top:20px;">
              Connectez-vous au CRM pour approuver ou rejeter cette demande.<br/>
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

async function createRequest(userId, { projectId, subject, message }) {
  const project = await Project.findByPk(projectId, { attributes: ["id", "nomProjet", "isArchived"] });
  if (!project) throw { status: 404, message: "Projet introuvable" };
  if (!project.isArchived) throw { status: 400, message: "Ce projet n'est pas archivé" };

  const existing = await ArchiveRequest.findOne({
    where: { projectId, userId, status: "pending" },
  });
  if (existing) {
    const err = new Error("Une demande en attente existe déjà pour ce projet");
    err.status = 409;
    err.requestId = existing.id;
    throw err;
  }

  // Auto-assign superadmin as adminId
  const admin = await User.findOne({
    where: { role: "superadmin" },
    attributes: ["id", "email"],
  });
  if (!admin) throw { status: 400, message: "Aucun superadmin trouvé — demande impossible" };

  const requester = await User.findByPk(userId, {
    attributes: ["id", "email"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name"], required: false }],
  });

  const request = await ArchiveRequest.create({
    projectId,
    userId,
    adminId: admin.id,
    subject,
    message,
    status: "pending",
  });

  // Notify the assigned admin in real-time
  const eventPayload = {
    requestId: request.id,
    projectId,
    projectName: project.nomProjet,
    userId,
    subject,
    createdAt: request.createdAt,
  };
  emitToUser(admin.id, "archive-request-created", eventPayload);
  emitToRoom("admins", "archive-request-created", eventPayload);

  // HTML email (fire-and-forget)
  const userName = requester?.profile?.name || requester?.email || "Utilisateur";
  const html = _buildAdminEmail({
    projectName: project.nomProjet,
    userName,
    userEmail: requester?.email || "",
    subject,
    message,
    requestId: request.id,
    createdAt: request.createdAt,
  });
  _sendHtml(admin.email, "Demande de désarchivage CRM", html).catch(() => null);

  return request;
}

async function approveRequest(adminId, requestId) {
  const request = await ArchiveRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.status !== "pending") throw { status: 400, message: "Cette demande a déjà été traitée" };

  await request.update({ status: "approved", adminId });

  await Project.update(
    { isArchived: false, archivedAt: null, archiveReason: null },
    { where: { id: request.projectId } }
  );

  await Notification.create({
    userId: request.userId,
    type: "ARCHIVE_REQUEST_APPROVED",
    title: "Désarchivage approuvé",
    message: "Votre demande de désarchivage a été approuvée",
    projectId: request.projectId,
    isRead: false,
  });

  emitToUser(request.userId, "archive-request-approved", {
    requestId,
    projectId: request.projectId,
    message: "Votre demande de désarchivage a été approuvée",
  });

  return request;
}

async function rejectRequest(adminId, requestId, reason) {
  const request = await ArchiveRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.status !== "pending") throw { status: 400, message: "Cette demande a déjà été traitée" };

  await request.update({ status: "rejected", adminId });

  await Notification.create({
    userId: request.userId,
    type: "ARCHIVE_REQUEST_REJECTED",
    title: "Désarchivage refusé",
    message: reason || "Votre demande de désarchivage a été refusée",
    projectId: request.projectId,
    isRead: false,
  });

  emitToUser(request.userId, "archive-request-rejected", {
    requestId,
    projectId: request.projectId,
    message: reason || "Votre demande de désarchivage a été refusée",
  });

  return request;
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

  // Notify the other party and the assigned admin
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

async function getMessages(requestId, userId, userRole) {
  const request = await ArchiveRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };

  const isAdmin = ["admin", "superadmin"].includes(userRole);
  if (!isAdmin && request.userId !== userId) throw { status: 403, message: "Accès refusé" };

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
  addMessage,
  getMyRequests,
  getAdminRequests,
  getMessages,
};
