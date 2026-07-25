"use strict";

const { Op } = require("sequelize");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const MaintenanceRequestComment = require("../../../models/MaintenanceRequestComment");
const MaintenanceRequestActivity = require("../../../models/MaintenanceRequestActivity");
const Notification = require("../../../models/Notification");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
const { emitToUser } = require("../../../socket");
const { sendEmail } = require("../../../services/email.service");
const { resolveFullName } = require("../../../utils/userDisplay");
const { MAINTENANCE_MANAGER_ROLES, isMaintenanceManager } = require("../../../middleware/requireMaintenanceManager");
const { MAINTENANCE_MANAGER_EMAIL } = require("../../../config/maintenanceManager");

const CRM_LINK = process.env.APP_URL || "http://localhost:3000";

const URGENCE_LABEL = { faible: "Faible", moyenne: "Moyenne", critique: "Critique" };
const STATUT_LABEL = {
  en_attente: "En attente",
  acceptee: "Acceptée",
  en_cours: "En cours",
  refusee: "Refusée",
  terminee: "Terminée",
};

// ── Helpers ───────────────────────────────────────────────

const REQUESTER_INCLUDE = {
  model: User,
  as: "requester",
  attributes: ["id", "email", "role"],
  include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom", "avatarUrl"], required: false }],
  required: false,
};

const TECHNICIAN_INCLUDE = {
  model: User,
  as: "technician",
  attributes: ["id", "email", "role"],
  include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
  required: false,
};

const FULL_INCLUDE = [REQUESTER_INCLUDE, TECHNICIAN_INCLUDE];

function _userShape(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: resolveFullName(u) };
}

async function _getManagers() {
  const managers = await User.findAll({
    where: {
      isActive: true,
      [Op.or]: [{ role: { [Op.in]: MAINTENANCE_MANAGER_ROLES } }, { email: MAINTENANCE_MANAGER_EMAIL }],
    },
    attributes: ["id", "email"],
  });
  return managers;
}

function _canAccess(request, userId, userRole, userEmail) {
  if (isMaintenanceManager(userRole, userEmail)) return true;
  return request.userId === userId;
}

// ── HTML email template (partagé création / accept / reject / assign / complete) ──

function _buildEmail({ heading, emoji, intro, requestRef, requesterName, requesterEmail, equipement, typePanne, urgence, message, createdAt, footerNote }) {
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

        <tr>
          <td style="background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);padding:36px 40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">
              ${emoji} ${heading}
            </h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">CRM PROBAR — Maintenance</p>
          </td>
        </tr>

        <tr>
          <td style="padding:40px;">
            <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
              ${intro}
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
              <tr>
                <td style="padding:24px;">
                  <table width="100%" cellpadding="0" cellspacing="8">
                    <tr>
                      <td width="140" style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">🔧 Équipement</td>
                      <td style="color:#111827;font-size:14px;font-weight:600;padding:6px 0;">${equipement}</td>
                    </tr>
                    <tr>
                      <td style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">⚠️ Type de panne</td>
                      <td style="color:#111827;font-size:14px;padding:6px 0;">${typePanne}</td>
                    </tr>
                    <tr>
                      <td style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">🚨 Urgence</td>
                      <td style="color:#111827;font-size:14px;padding:6px 0;">${URGENCE_LABEL[urgence] || urgence}</td>
                    </tr>
                    <tr>
                      <td style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">👤 Demandeur</td>
                      <td style="color:#111827;font-size:14px;padding:6px 0;">${requesterName} &lt;${requesterEmail}&gt;</td>
                    </tr>
                    <tr>
                      <td style="color:#6b7280;font-size:13px;font-weight:600;padding:6px 0;vertical-align:top;">📅 Date</td>
                      <td style="color:#111827;font-size:14px;padding:6px 0;">${date}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 8px;color:#374151;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Description</p>
            <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:32px;">
              <p style="margin:0;color:#92400e;font-size:14px;line-height:1.7;">${message || "—"}</p>
            </div>

            <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;border-top:1px solid #f3f4f6;padding-top:20px;">
              ${footerNote}<br/>
              <a href="${CRM_LINK}" style="color:#f59e0b;">Ouvrir le CRM</a> ·
              Réf. demande : <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${requestRef}</code>
            </p>
          </td>
        </tr>

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

// ── Service functions ─────────────────────────────────────

async function createRequest(userId, { equipement, typePanne, urgence, description }, photoPaths = []) {
  const requester = await User.findByPk(userId, {
    attributes: ["id", "email"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
  });
  if (!requester) throw { status: 404, message: "Utilisateur introuvable" };

  const request = await MaintenanceRequest.create({
    userId,
    equipement,
    typePanne,
    urgence: urgence || "moyenne",
    description: description || null,
    photos: photoPaths,
    statut: "en_attente",
  });

  const requesterName = resolveFullName(requester);

  await MaintenanceRequestActivity.create({
    requestId: request.id,
    userId,
    type: "created",
    message: "Demande créée.",
  });

  const managers = await _getManagers();
  const intro = `${requesterName} a signalé une panne nécessitant une intervention de maintenance.`;
  const html = _buildEmail({
    heading: "Nouvelle demande de maintenance",
    emoji: "🛠️",
    intro,
    requestRef: request.ticketNo,
    requesterName,
    requesterEmail: requester.email,
    equipement,
    typePanne,
    urgence: request.urgence,
    message: description,
    createdAt: request.createdAt,
    footerNote: "Connectez-vous au CRM pour traiter cette demande.",
  });

  for (const manager of managers) {
    await Notification.create({
      userId: manager.id,
      type: "MAINTENANCE_REQUEST_CREATED",
      title: "Nouvelle demande de maintenance",
      message: `${requesterName} a signalé une panne sur "${equipement}"`,
      maintenanceRequestId: request.id,
      isRead: false,
    });
    emitToUser(manager.id, "maintenance-request-created", {
      requestId: request.id,
      equipement,
      urgence: request.urgence,
      createdAt: request.createdAt,
    });
    sendEmail(manager.email, "Nouvelle demande de maintenance", intro, { requestId: request.id }, { html }).catch(() => null);
  }

  return request;
}

async function acceptRequest(managerId, requestId) {
  const request = await MaintenanceRequest.findByPk(requestId, { include: FULL_INCLUDE });
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.statut !== "en_attente") throw { status: 400, message: "Cette demande a déjà été traitée" };

  const processedAt = new Date();
  await request.update({ statut: "acceptee", acceptedBy: managerId, processedAt });

  await MaintenanceRequestActivity.create({
    requestId: request.id,
    userId: managerId,
    type: "accepted",
    message: "Demande acceptée.",
    metadata: { acceptedBy: managerId, processedAt },
  });

  await _notifyRequester(request, {
    type: "MAINTENANCE_REQUEST_ACCEPTED",
    title: "Demande de maintenance acceptée",
    message: `Votre demande concernant "${request.equipement}" a été acceptée`,
    event: "maintenance-request-accepted",
    emailHeading: "Demande de maintenance acceptée",
    emoji: "✅",
    intro: `Votre demande de maintenance concernant <strong>${request.equipement}</strong> a été acceptée.`,
  });

  return request;
}

async function rejectRequest(managerId, requestId, reason) {
  const request = await MaintenanceRequest.findByPk(requestId, { include: FULL_INCLUDE });
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.statut !== "en_attente") throw { status: 400, message: "Cette demande a déjà été traitée" };

  const processedAt = new Date();
  const rejectionReason = reason || "Votre demande de maintenance a été refusée";
  await request.update({ statut: "refusee", rejectedBy: managerId, rejectionReason, processedAt });

  await MaintenanceRequestActivity.create({
    requestId: request.id,
    userId: managerId,
    type: "rejected",
    message: "Demande refusée.",
    metadata: { rejectedBy: managerId, processedAt, reason: reason || null },
  });

  await _notifyRequester(request, {
    type: "MAINTENANCE_REQUEST_REJECTED",
    title: "Demande de maintenance refusée",
    message: rejectionReason,
    event: "maintenance-request-rejected",
    emailHeading: "Demande de maintenance refusée",
    emoji: "❌",
    intro: `Votre demande de maintenance concernant <strong>${request.equipement}</strong> a été refusée.${reason ? ` Motif : ${reason}` : ""}`,
  });

  return request;
}

async function assignTechnician(managerId, requestId, technicianId) {
  const request = await MaintenanceRequest.findByPk(requestId, { include: FULL_INCLUDE });
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.statut === "refusee" || request.statut === "terminee") {
    throw { status: 400, message: "Cette demande est clôturée" };
  }

  const technician = await User.findByPk(technicianId, { attributes: ["id", "email"], include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }] });
  if (!technician) throw { status: 404, message: "Technicien introuvable" };

  const assignedAt = new Date();
  await request.update({ technicianId, assignedAt, assignedBy: managerId });

  const technicianName = resolveFullName(technician);
  await MaintenanceRequestActivity.create({
    requestId: request.id,
    userId: managerId,
    type: "assigned",
    message: `Affectée à ${technicianName}.`,
    metadata: { technicianId, assignedAt, assignedBy: managerId },
  });

  await _notifyRequester(request, {
    type: "MAINTENANCE_REQUEST_ASSIGNED",
    title: "Technicien affecté",
    message: `${technicianName} a été affecté à votre demande concernant "${request.equipement}"`,
    event: "maintenance-request-assigned",
    emailHeading: "Technicien affecté à votre demande",
    emoji: "🧑‍🔧",
    intro: `<strong>${technicianName}</strong> a été affecté à votre demande de maintenance concernant <strong>${request.equipement}</strong>.`,
  });

  await Notification.create({
    userId: technician.id,
    type: "MAINTENANCE_REQUEST_ASSIGNED",
    title: "Nouvelle intervention affectée",
    message: `Vous avez été affecté à une demande de maintenance sur "${request.equipement}"`,
    maintenanceRequestId: request.id,
    isRead: false,
  });
  emitToUser(technician.id, "maintenance-request-assigned", { requestId: request.id, equipement: request.equipement });
  sendEmail(
    technician.email,
    "Nouvelle intervention de maintenance affectée",
    `Vous avez été affecté à une demande de maintenance sur "${request.equipement}".`,
    { requestId: request.id },
    {
      html: _buildEmail({
        heading: "Intervention affectée",
        emoji: "🧑‍🔧",
        intro: `Vous avez été affecté à une demande de maintenance concernant <strong>${request.equipement}</strong>.`,
        requestRef: request.ticketNo,
        requesterName: resolveFullName(request.requester),
        requesterEmail: request.requester?.email || "",
        equipement: request.equipement,
        typePanne: request.typePanne,
        urgence: request.urgence,
        message: request.description,
        createdAt: request.createdAt,
        footerNote: "Connectez-vous au CRM pour consulter la fiche complète.",
      }),
    }
  ).catch(() => null);

  return request;
}

async function startRequest(managerId, requestId) {
  const request = await MaintenanceRequest.findByPk(requestId, { include: FULL_INCLUDE });
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.statut !== "acceptee") throw { status: 400, message: "Seule une demande acceptée peut passer en cours" };
  if (!request.technicianId) throw { status: 400, message: "Affectez un technicien avant de démarrer l'intervention" };

  const startedAt = new Date();
  await request.update({ statut: "en_cours", startedBy: managerId, startedAt });

  await MaintenanceRequestActivity.create({
    requestId: request.id,
    userId: managerId,
    type: "started",
    message: "Intervention démarrée.",
    metadata: { startedBy: managerId, startedAt },
  });

  await _notifyRequester(request, {
    type: "MAINTENANCE_REQUEST_STARTED",
    title: "Intervention en cours",
    message: `Votre demande concernant "${request.equipement}" est en cours de traitement`,
    event: "maintenance-request-started",
    emailHeading: "Intervention en cours",
    emoji: "🔧",
    intro: `Votre demande de maintenance concernant <strong>${request.equipement}</strong> est en cours de traitement.`,
  });

  return request;
}

async function completeRequest(managerId, requestId) {
  const request = await MaintenanceRequest.findByPk(requestId, { include: FULL_INCLUDE });
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (request.statut !== "en_cours") throw { status: 400, message: "Seule une demande en cours peut être marquée terminée" };

  const completedAt = new Date();
  await request.update({ statut: "terminee", completedBy: managerId, completedAt });

  await MaintenanceRequestActivity.create({
    requestId: request.id,
    userId: managerId,
    type: "completed",
    message: "Maintenance terminée.",
    metadata: { completedBy: managerId, completedAt },
  });

  await _notifyRequester(request, {
    type: "MAINTENANCE_REQUEST_COMPLETED",
    title: "Maintenance terminée",
    message: `La maintenance de "${request.equipement}" est terminée`,
    event: "maintenance-request-completed",
    emailHeading: "Maintenance terminée",
    emoji: "🏁",
    intro: `La maintenance concernant <strong>${request.equipement}</strong> est terminée.`,
  });

  return request;
}

async function _notifyRequester(request, { type, title, message, event, emailHeading, emoji, intro }) {
  const requester = request.requester;

  await Notification.create({
    userId: request.userId,
    type,
    title,
    message,
    maintenanceRequestId: request.id,
    isRead: false,
  });

  emitToUser(request.userId, event, { requestId: request.id, equipement: request.equipement, message });

  if (requester?.email) {
    const html = _buildEmail({
      heading: emailHeading,
      emoji,
      intro,
      requestRef: request.ticketNo,
      requesterName: resolveFullName(requester),
      requesterEmail: requester.email,
      equipement: request.equipement,
      typePanne: request.typePanne,
      urgence: request.urgence,
      message: request.description,
      createdAt: request.createdAt,
      footerNote: "Ceci est une confirmation automatique du CRM.",
    });
    sendEmail(requester.email, title, message, { requestId: request.id }, { html }).catch(() => null);
  }
}

async function deleteRequest(requestId) {
  const request = await MaintenanceRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };
  await request.destroy();
  return { id: requestId };
}

async function getStats() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  const [total, enAttente, acceptee, enCours, refusee, terminee, critique, today, thisWeek] = await Promise.all([
    MaintenanceRequest.count(),
    MaintenanceRequest.count({ where: { statut: "en_attente" } }),
    MaintenanceRequest.count({ where: { statut: "acceptee" } }),
    MaintenanceRequest.count({ where: { statut: "en_cours" } }),
    MaintenanceRequest.count({ where: { statut: "refusee" } }),
    MaintenanceRequest.count({ where: { statut: "terminee" } }),
    MaintenanceRequest.count({ where: { urgence: "critique" } }),
    MaintenanceRequest.count({ where: { createdAt: { [Op.gte]: startOfDay } } }),
    MaintenanceRequest.count({ where: { createdAt: { [Op.gte]: startOfWeek } } }),
  ]);

  return { total, enAttente, acceptee, enCours, refusee, terminee, critique, today, thisWeek };
}

async function getMyRequests(userId) {
  return MaintenanceRequest.findAll({
    where: { userId },
    include: FULL_INCLUDE,
    order: [["createdAt", "DESC"]],
  });
}

async function getAllRequests({ statut, urgence, search } = {}) {
  const where = {};
  if (statut) where.statut = statut;
  if (urgence) where.urgence = urgence;

  const include = FULL_INCLUDE;

  let requests = await MaintenanceRequest.findAll({
    where,
    include,
    order: [["createdAt", "DESC"]],
  });

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    requests = requests.filter((r) => {
      const requesterName = resolveFullName(r.requester).toLowerCase();
      const requesterEmail = (r.requester?.email || "").toLowerCase();
      return (
        r.equipement.toLowerCase().includes(q) ||
        r.typePanne.toLowerCase().includes(q) ||
        requesterName.includes(q) ||
        requesterEmail.includes(q)
      );
    });
  }

  return requests;
}

async function getById(userId, userRole, requestId, userEmail) {
  const request = await MaintenanceRequest.findByPk(requestId, { include: FULL_INCLUDE });
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (!_canAccess(request, userId, userRole, userEmail)) throw { status: 403, message: "Accès refusé" };
  return request;
}

async function getTechnicians() {
  const users = await User.findAll({
    where: { isActive: true },
    attributes: ["id", "email", "role"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
    order: [["email", "ASC"]],
  });
  return users.map((u) => ({ id: u.id, email: u.email, name: resolveFullName(u), role: u.role }));
}

async function addComment(senderId, requestId, messageText) {
  const request = await MaintenanceRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };

  const sender = await User.findByPk(senderId, {
    attributes: ["id", "email"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom", "avatarUrl"], required: false }],
  });

  const comment = await MaintenanceRequestComment.create({ requestId, senderId, message: messageText });

  const payload = {
    id: comment.id,
    requestId,
    message: messageText,
    createdAt: comment.createdAt,
    sender: _userShape(sender),
  };

  if (senderId !== request.userId) emitToUser(request.userId, "maintenance-request-comment", payload);
  if (request.technicianId && senderId !== request.technicianId) emitToUser(request.technicianId, "maintenance-request-comment", payload);

  return payload;
}

async function getComments(userId, userRole, requestId, userEmail) {
  const request = await MaintenanceRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (!_canAccess(request, userId, userRole, userEmail)) throw { status: 403, message: "Accès refusé" };

  const comments = await MaintenanceRequestComment.findAll({
    where: { requestId },
    include: [
      {
        model: User,
        as: "sender",
        attributes: ["id", "email"],
        include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom", "avatarUrl"], required: false }],
        required: false,
      },
    ],
    order: [["createdAt", "ASC"]],
  });

  return comments.map((c) => {
    const j = c.toJSON();
    return { ...j, sender: _userShape(j.sender) };
  });
}

async function getHistory(userId, userRole, requestId, userEmail) {
  const request = await MaintenanceRequest.findByPk(requestId);
  if (!request) throw { status: 404, message: "Demande introuvable" };
  if (!_canAccess(request, userId, userRole, userEmail)) throw { status: 403, message: "Accès refusé" };

  const activities = await MaintenanceRequestActivity.findAll({
    where: { requestId },
    include: [
      { model: User, as: "actor", attributes: ["id", "email"], include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }], required: false },
    ],
    order: [["createdAt", "ASC"]],
  });

  return activities.map((a) => {
    const j = a.toJSON();
    return { ...j, actor: _userShape(j.actor) };
  });
}

module.exports = {
  createRequest,
  acceptRequest,
  rejectRequest,
  assignTechnician,
  startRequest,
  completeRequest,
  deleteRequest,
  getStats,
  getMyRequests,
  getAllRequests,
  getById,
  getTechnicians,
  addComment,
  getComments,
  getHistory,
  URGENCE_LABEL,
  STATUT_LABEL,
};
